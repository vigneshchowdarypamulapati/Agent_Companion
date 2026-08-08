import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { realQueryFn } from './real-agent-sdk.js';
import { getOrCreateDeviceToken } from './device-auth.js';
import { RelayClient } from './relay-client.js';
import { dispatchCommand } from './command-dispatcher.js';
import type { SessionEvent } from '@companion/protocol';

const PORT = Number(process.env.COMPANION_DAEMON_PORT ?? 4310);
const RELAY_URL = process.env.COMPANION_RELAY_URL;
const DEVICE_NAME = process.env.COMPANION_DEVICE_NAME ?? hostname();
const DEVICE_TOKEN_PATH =
  process.env.COMPANION_DEVICE_TOKEN_PATH ?? join(homedir(), '.companion', 'daemon-device.json');

function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http');
}

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

  const app = createHttpServer(manager, eventLog);
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Companion daemon control surface listening on http://127.0.0.1:${PORT}`);
  });

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
      console.error(
        `Failed to connect to the relay (local HTTP control surface remains available): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal error starting daemon:', err);
  process.exit(1);
});
