import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { RelayMessage, RedeemPairingRequest } from '@companion/protocol';
import type { Device, Store } from './store.js';
import type { PubSub } from './pubsub.js';
import { PairingService } from './pairing.js';
import { ConnectionHub, type Connection } from './hub.js';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/**
 * Extracts a device token from the `Authorization: Bearer <token>` header and verifies it.
 * REST callers can set headers, so unlike the WS handshake they do not use query-param auth.
 */
async function authenticate(req: Request, pairing: PairingService): Promise<Device | undefined> {
  const header = req.header('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return undefined;
  return pairing.verifyToken(token);
}

export interface RelayServerOptions {
  store: Store;
  pubsub: PubSub;
}

export async function createRelayServer({ store, pubsub }: RelayServerOptions): Promise<Server> {
  const pairing = new PairingService(store);
  const hub = new ConnectionHub(store, pubsub);
  await hub.start();

  const app = express();
  app.use(express.json());

  app.post(
    '/pairing/request-code',
    asyncHandler(async (_req, res) => {
      const result = await pairing.requestPairingCode();
      res.status(201).json(result);
    })
  );

  app.post(
    '/pairing/redeem',
    asyncHandler(async (req, res) => {
      const { code, deviceType, deviceName } = RedeemPairingRequest.parse(req.body);
      const result = await pairing.redeemPairingCode(code, deviceType, deviceName);
      if (!result) {
        res.status(400).json({ error: 'Invalid or expired pairing code' });
        return;
      }
      res.status(201).json({ token: result.token, deviceId: result.device.id });
    })
  );

  app.get(
    '/sessions/active',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getActiveSessionForUser(device.userId);
      if (!session) {
        res.status(404).json({ error: 'No active session' });
        return;
      }
      res.status(200).json(session);
    })
  );

  app.get(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getSession(req.params.id);
      // Same response whether the session is missing or owned by someone else, so a
      // non-owner cannot enumerate session ids.
      if (!session || session.userId !== device.userId) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      res.status(200).json(session);
    })
  );

  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getSession(req.params.id);
      if (!session || session.userId !== device.userId) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      const sinceSeq = req.query.since ? Number(req.query.since) : undefined;
      const events = await store.getSessionEvents(req.params.id, sinceSeq);
      res.status(200).json(events);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // An 'error' event with no listener is an uncaught exception, which terminates the process.
  wss.on('error', () => {});

  wss.on('connection', (ws, req) => {
    // Attached first, before any async work, so a malformed frame arriving immediately after
    // the handshake cannot crash the process. The 'close' handler still fires afterwards.
    ws.on('error', () => {});

    void (async () => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const token = url.searchParams.get('token');
        if (!token) {
          ws.close(4401, 'Missing token');
          return;
        }
        const device = await pairing.verifyToken(token);
        if (!device) {
          ws.close(4401, 'Invalid token');
          return;
        }

        const connection: Connection = {
          deviceId: device.id,
          userId: device.userId,
          deviceType: device.type,
          send: (message) => ws.send(JSON.stringify(message)),
        };
        hub.register(connection);

        ws.on('message', (raw) => {
          void (async () => {
            try {
              const parsed = RelayMessage.parse(JSON.parse(raw.toString()));
              if (parsed.kind === 'event' && device.type === 'daemon') {
                await hub.routeFromDaemon(connection, parsed.sessionId, parsed.event);
              } else if (parsed.kind === 'command' && device.type === 'browser') {
                await hub.routeFromBrowser(connection, parsed.sessionId, parsed.command);
              }
            } catch (err) {
              // Diagnostic frame — deliberately not part of the RelayMessage schema.
              const message = err instanceof Error ? err.message : String(err);
              try {
                ws.send(JSON.stringify({ kind: 'error', message }));
              } catch {
                // Socket already gone; nothing useful to do, and throwing here would
                // surface as an unhandled rejection.
              }
            }
          })();
        });

        ws.on('close', () => hub.unregister(connection));
      } catch {
        // Unexpected error during setup (e.g., store failure) — close cleanly.
        ws.close(1011, 'Internal error');
      }
    })();
  });

  return httpServer;
}
