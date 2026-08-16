import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { realQueryFn } from './real-agent-sdk.js';
import { getOrCreateDeviceToken } from './device-auth.js';
import { getOrCreateLocalToken } from './local-auth.js';
import { RelayClient } from './relay-client.js';
import { dispatchCommand } from './command-dispatcher.js';
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

async function main(): Promise<void> {
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
    try {
      const { token } = await getOrCreateDeviceToken({
        relayHttpUrl: relayHttpUrl(RELAY_URL),
        deviceName: DEVICE_NAME,
        tokenPath: DEVICE_TOKEN_PATH,
      });

      relayClient = new RelayClient({
        url: RELAY_URL,
        token,
        onLog: (message) => console.log(`[relay] ${message}`),
        onCommand: (command) => {
          void dispatchCommand(manager, command).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            if (!('sessionId' in command)) {
              console.error(`Relay command failed: ${message}`);
              return;
            }
            const errorEvent: SessionEvent = {
              type: 'command_failed',
              sessionId: command.sessionId,
              message,
              at: Date.now(),
            };
            eventLog.push(errorEvent);
            relayClient?.sendEvent(command.sessionId, errorEvent);
          });
        },
      });
      relayClient.connect();
      console.log(`Connecting to relay at ${RELAY_URL}`);
    } catch (err) {
      const suffix = HTTP_ENABLED ? ' (local HTTP control surface remains available)' : '';
      console.error(
        `Failed to connect to the relay${suffix}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
