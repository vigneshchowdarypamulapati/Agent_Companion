import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DeviceCredentials {
  token: string;
  deviceId: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DeviceAuthOptions {
  relayHttpUrl: string;
  deviceName: string;
  tokenPath: string;
  fetchFn?: FetchLike;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Groups the relay's pairing code into `XXXX-XXXX` for typeability, e.g.
 * `ABCD1234` -> `ABCD-1234`. Purely cosmetic: the relay's own matching
 * (PairingService.claimPairingCode) already ignores hyphens/whitespace and
 * is case-insensitive, so this grouping doesn't need to round-trip exactly
 * — it just has to be easy for a human to read and type back correctly.
 */
function formatPairingCodeForDisplay(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/**
 * Returns this daemon's device credentials, reading them from `tokenPath` if
 * present. On first run (no token file yet), requests a pairing code from
 * the relay, prints it for a human to enter in their already-authenticated
 * Companion web app, then polls until that claim completes and the relay
 * mints this daemon's device token.
 */
export async function getOrCreateDeviceToken(options: DeviceAuthOptions): Promise<DeviceCredentials> {
  const existing = await readExisting(options.tokenPath);
  if (existing) return existing;

  const fetchFn = options.fetchFn ?? defaultFetch;
  const credentials = await pairNewDevice(options.relayHttpUrl, options.deviceName, fetchFn);
  await persist(options.tokenPath, credentials);
  return credentials;
}

async function readExisting(tokenPath: string): Promise<DeviceCredentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<DeviceCredentials>;
  if (typeof parsed.token !== 'string' || typeof parsed.deviceId !== 'string') {
    throw new Error(`Device token file at ${tokenPath} is malformed`);
  }
  return { token: parsed.token, deviceId: parsed.deviceId };
}

export const POLL_INTERVAL_MS = 2000;

async function pairNewDevice(
  relayHttpUrl: string,
  deviceName: string,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  // Strip a trailing slash the same way relay-client.ts does, so a
  // COMPANION_RELAY_URL like `ws://host:8787/` cannot produce `...//request-code`.
  const base = relayHttpUrl.replace(/\/$/, '');
  const codeRes = await fetchFn(`${base}/pairing/request-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  });
  if (!codeRes.ok) {
    throw new Error(`Failed to request a pairing code from the relay: HTTP ${codeRes.status}`);
  }
  const { code, deviceCode, expiresAt } = (await codeRes.json()) as {
    code: string;
    deviceCode: string;
    expiresAt: number;
  };

  console.log(`Pairing code: ${formatPairingCodeForDisplay(code)}`);
  console.log('Open the Companion web app, go to Settings, and enter this code under "Pair a daemon"');
  console.log('to link this daemon to your account. (Case doesn\'t matter, and the hyphen is optional.)');

  return pollForToken(base, deviceCode, expiresAt, fetchFn);
}

async function pollForToken(
  base: string,
  deviceCode: string,
  expiresAt: number,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  while (Date.now() < expiresAt) {
    // A relay hiccup (5xx, dropped connection, DNS blip) during a multi-minute
    // window a human is standing in front of must not abort the whole pairing
    // attempt — those are retried exactly like a `pending` result, still bounded
    // by the same expiresAt deadline. A 4xx is different: it means this daemon is
    // asking wrongly, which retrying cannot fix, so it still throws immediately.
    let pollRes: Awaited<ReturnType<FetchLike>>;
    try {
      pollRes = await fetchFn(`${base}/pairing/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
    } catch {
      // Network-level failure: relay restarting, connection reset, DNS blip.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!pollRes.ok) {
      if (pollRes.status < 500) {
        throw new Error(`Failed to poll pairing status: HTTP ${pollRes.status}`);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    let result:
      | { status: 'pending' }
      | { status: 'expired' }
      | { status: 'complete'; token: string; deviceId: string };
    try {
      result = (await pollRes.json()) as typeof result;
    } catch {
      // A 200 whose body isn't JSON (a proxy's error page, a truncated
      // response) is the same class of blip as the two above.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (result.status === 'complete') {
      return { token: result.token, deviceId: result.deviceId };
    }
    if (result.status === 'expired') {
      throw new Error('Pairing code expired before it was claimed');
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Pairing code expired before it was claimed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persist(tokenPath: string, credentials: DeviceCredentials): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}
