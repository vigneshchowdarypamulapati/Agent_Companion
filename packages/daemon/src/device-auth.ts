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
 * present. On first run (no token file yet), self-pairs against the relay:
 * `/pairing/request-code` is intentionally unauthenticated in v1 — it
 * bootstraps the very first device for the single seeded user (see
 * packages/relay/README.md) — so the daemon can mint its own device token
 * with no human pairing step. Later devices (the web app) pair using a code
 * generated from an already-authenticated session instead.
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

async function pairNewDevice(
  relayHttpUrl: string,
  deviceName: string,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  // Strip a trailing slash the same way relay-client.ts does, so a
  // COMPANION_RELAY_URL like `ws://host:8787/` cannot produce `...//request-code`.
  const base = relayHttpUrl.replace(/\/$/, '');
  const codeRes = await fetchFn(`${base}/pairing/request-code`, { method: 'POST' });
  if (!codeRes.ok) {
    throw new Error(`Failed to request a pairing code from the relay: HTTP ${codeRes.status}`);
  }
  const { code } = (await codeRes.json()) as { code: string };

  const redeemRes = await fetchFn(`${base}/pairing/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceType: 'daemon', deviceName }),
  });
  if (!redeemRes.ok) {
    throw new Error(`Failed to redeem pairing code with the relay: HTTP ${redeemRes.status}`);
  }
  const { token, deviceId } = (await redeemRes.json()) as { token: string; deviceId: string };
  return { token, deviceId };
}

async function persist(tokenPath: string, credentials: DeviceCredentials): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}
