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

  console.log(`Pairing code: ${code}`);
  console.log('Enter this code in the Companion web app to link this daemon to your account.');

  return pollForToken(base, deviceCode, expiresAt, fetchFn);
}

async function pollForToken(
  base: string,
  deviceCode: string,
  expiresAt: number,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  while (Date.now() < expiresAt) {
    const pollRes = await fetchFn(`${base}/pairing/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });
    if (!pollRes.ok) {
      throw new Error(`Failed to poll pairing status: HTTP ${pollRes.status}`);
    }
    const result = (await pollRes.json()) as
      | { status: 'pending' }
      | { status: 'expired' }
      | { status: 'complete'; token: string; deviceId: string };
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
