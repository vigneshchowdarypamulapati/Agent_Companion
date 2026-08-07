import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { realQueryFn } from './real-agent-sdk.js';
import type { SessionEvent } from '@companion/protocol';

const PORT = Number(process.env.COMPANION_DAEMON_PORT ?? 4310);

const eventLog: SessionEvent[] = [];
const manager = new SessionManager({
  queryFn: realQueryFn,
  onEvent: (event) => {
    eventLog.push(event);
    console.log(`[${event.sessionId}] ${event.type}`);
  },
});

const app = createHttpServer(manager, eventLog);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Companion daemon control surface listening on http://127.0.0.1:${PORT}`);
});
