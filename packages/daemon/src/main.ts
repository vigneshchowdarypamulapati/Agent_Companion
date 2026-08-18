import { hostname, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { realQueryFn } from './real-agent-sdk.js';
import { getOrCreateDeviceToken } from './device-auth.js';
import { getOrCreateLocalToken } from './local-auth.js';
import { RelayClient } from './relay-client.js';
import { dispatchCommandWithAck } from './command-dispatcher.js';
import { dispatchRpc } from './rpc-handlers.js';
import type { SessionEvent } from '@companion/protocol';

const PORT = Number(process.env.COMPANION_DAEMON_PORT ?? 4310);
const RELAY_URL = process.env.COMPANION_RELAY_URL;
const DEVICE_NAME = process.env.COMPANION_DEVICE_NAME ?? hostname();
const DEVICE_TOKEN_PATH =
  process.env.COMPANION_DEVICE_TOKEN_PATH ?? join(homedir(), '.companion', 'daemon-device.json');
const LOCAL_HTTP_TOKEN_PATH =
  process.env.COMPANION_LOCAL_HTTP_TOKEN_PATH ?? join(homedir(), '.companion', 'daemon-local-http.json');

function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http');
}

/**
 * Reads this package's own `version` field out of package.json at startup, rather than hardcoding
 * a copy here that would silently drift the next time package.json is bumped. `dist/main.js` and
 * `src/main.ts` are both exactly one directory below the package root (see tsconfig.json's
 * `rootDir`/`outDir`), so `../package.json` resolves correctly whether this runs from source
 * (tests, `tsx`) or from the built `dist/`. Falls back to 'unknown' rather than throwing — a
 * missing/unreadable package.json should never be why the daemon can't start.
 */
function readDaemonVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const DAEMON_VERSION = readDaemonVersion();
// Captured once at module load, not per-ping: `ping`'s uptimeMs must measure how long this
// process has been running, not how long it's been since the last call.
const DAEMON_STARTED_AT = Date.now();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const RELAY_CONNECT_INITIAL_BACKOFF_MS = 2000;
export const RELAY_CONNECT_MAX_BACKOFF_MS = 30_000;

export interface ConnectWithRetryOptions {
  onError: (err: unknown, attempt: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Retries `connectOnce` with capped exponential backoff until it succeeds,
 * instead of giving up after the first failure.
 *
 * Before this existed, a single failure while first establishing the relay
 * connection (relay unreachable at startup, or a pairing code expiring
 * before a human claimed it) was caught once, logged, and main() simply
 * returned. With the local HTTP surface now off by default, nothing was
 * left holding the Node event loop open at that point, so the daemon
 * exited 0 immediately — indistinguishable from a clean intentional
 * shutdown to a process supervisor, on what is actually the production
 * control channel failing to start. Retrying forever means there is
 * always a pending timer (and, once connected, an open socket) keeping
 * the process alive, and the relay connection self-heals once the relay
 * becomes reachable again instead of requiring an external restart.
 *
 * Note this only covers the *first* connection attempt (device pairing +
 * constructing the RelayClient) — once `connectOnce` succeeds, ongoing
 * disconnects are already handled by RelayClient's own reconnect-with-
 * backoff (relay-client.ts), so the two don't overlap or duplicate effort.
 */
export async function connectWithRetry(
  connectOnce: () => Promise<void>,
  options: ConnectWithRetryOptions
): Promise<void> {
  const sleepFn = options.sleepFn ?? sleep;
  const initialBackoffMs = options.initialBackoffMs ?? RELAY_CONNECT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? RELAY_CONNECT_MAX_BACKOFF_MS;
  let backoffMs = initialBackoffMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await connectOnce();
      return;
    } catch (err) {
      options.onError(err, attempt);
      await sleepFn(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

/**
 * The local HTTP control surface is off unless explicitly opted into: it
 * exposes full tool-executing session control (POST /sessions et al.) on
 * loopback, and in production the relay connection is the only control
 * channel that should exist. Only "1" or "true" (case-insensitive) turn it
 * on; unset or any other value — including typos — means off.
 */
export function isHttpSurfaceEnabled(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  return normalized === '1' || normalized === 'true';
}

const HTTP_ENABLED = isHttpSurfaceEnabled(process.env.COMPANION_DAEMON_HTTP);

/**
 * A daemon with neither control channel configured — no `COMPANION_RELAY_URL` and the local
 * HTTP surface off (its default) — is a misconfiguration, not a valid idle state: nothing can
 * ever start, stop, or observe a session on it. Before `connectWithRetry` existed, this shape
 * exited 0 as soon as the (now-removed) single relay-connect attempt failed; after it existed,
 * this second, distinct path survived — the *default* configuration (both unset, e.g. a fresh
 * `npm run build && npm start` with no env vars at all, per the daemon README) leaves nothing
 * holding the Node event loop open, so the process still prints one informational line and
 * exits 0. A process supervisor reads exit 0 as an intentional clean shutdown and neither
 * restarts nor alerts on it. Returns an Error describing both ways to fix it (rather than
 * throwing directly) so main() can decide how to surface it, and so this check is unit
 * testable without executing any of main()'s I/O.
 */
export function noControlChannelConfiguredError(
  httpEnabled: boolean,
  relayUrl: string | undefined
): Error | undefined {
  if (httpEnabled || relayUrl) return undefined;
  return new Error(
    'No control channel is configured: neither COMPANION_RELAY_URL nor COMPANION_DAEMON_HTTP ' +
      'is set. Set COMPANION_RELAY_URL to connect this daemon to a relay, or set ' +
      'COMPANION_DAEMON_HTTP=1 to enable the local HTTP control surface for local development. ' +
      'Refusing to start with neither — there would be no way to ever control this daemon.'
  );
}

export async function main(): Promise<void> {
  const noControlChannelError = noControlChannelConfiguredError(HTTP_ENABLED, RELAY_URL);
  if (noControlChannelError) throw noControlChannelError;

  let relayClient: RelayClient | undefined;

  const eventLog: SessionEvent[] = [];
  const manager = new SessionManager({
    queryFn: realQueryFn,
    onEvent: (event) => {
      eventLog.push(event);
      console.log(`[${event.sessionId}] ${event.type}`);
      relayClient?.sendEvent(event.sessionId, event);
    },
  });

  if (HTTP_ENABLED) {
    const token = await getOrCreateLocalToken({ tokenPath: LOCAL_HTTP_TOKEN_PATH });
    const app = createHttpServer(manager, eventLog, { token });
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`Companion daemon control surface listening on http://127.0.0.1:${PORT}`);
      console.log(`Local HTTP auth token (Authorization: Bearer <token>): ${token}`);
    });
  } else {
    console.log(
      'Local HTTP control surface disabled (set COMPANION_DAEMON_HTTP=1 to enable it for local development).'
    );
  }

  if (RELAY_URL) {
    // Fire-and-forget: connectWithRetry never rejects (it retries forever
    // rather than throwing), so this never produces an unhandled rejection.
    // main() itself returns without waiting for the relay to actually be up,
    // same as before — the pending retry timer (or, once connected, the open
    // socket) is what now keeps the process alive instead.
    void connectWithRetry(
      async () => {
        const { token } = await getOrCreateDeviceToken({
          relayHttpUrl: relayHttpUrl(RELAY_URL),
          deviceName: DEVICE_NAME,
          tokenPath: DEVICE_TOKEN_PATH,
        });

        relayClient = new RelayClient({
          url: RELAY_URL,
          token,
          onLog: (message) => console.log(`[relay] ${message}`),
          // `commandId` here is purely a delivery-tracking handle for the command_ack — it has
          // no bearing on *what* the command does, so dispatchCommandWithAck's own dispatch call
          // never sees it. See dispatchCommandWithAck's doc comment (command-dispatcher.ts) for
          // why the ack it sends and the command_failed event raised below are two distinct,
          // deliberately-not-collapsed signals.
          onCommand: (commandId, command) => {
            void dispatchCommandWithAck(manager, command, (status, message) =>
              relayClient?.sendCommandAck(commandId, status, message)
            ).then((result) => {
              if (result.ok) return;
              if (!('sessionId' in command)) {
                console.error(`Relay command failed: ${result.message}`);
                return;
              }
              const errorEvent: SessionEvent = {
                type: 'command_failed',
                sessionId: command.sessionId,
                message: result.message,
                at: Date.now(),
              };
              eventLog.push(errorEvent);
              relayClient?.sendEvent(command.sessionId, errorEvent);
            });
          },
          onRpcRequest: (method, params) => dispatchRpc(method, params, { version: DAEMON_VERSION, startedAt: DAEMON_STARTED_AT }),
        });
        relayClient.connect();
        console.log(`Connecting to relay at ${RELAY_URL}`);
      },
      {
        onError: (err, attempt) => {
          console.error(
            `Failed to connect to the relay (attempt ${attempt}, retrying): ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        },
      }
    );
  }
}

// Guard the top-level run so this module can be imported (e.g. from tests)
// without starting a real daemon — only run when executed directly as the
// entrypoint, i.e. `node dist/main.js`.
const isEntrypoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    console.error('Fatal error starting daemon:', err);
    process.exit(1);
  });
}
