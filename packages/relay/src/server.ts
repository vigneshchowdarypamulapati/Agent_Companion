import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { RelayMessage, RedeemPairingRequest } from '@companion/protocol';
import type { Store } from './store.js';
import type { PubSub } from './pubsub.js';
import { PairingService } from './pairing.js';
import { ConnectionHub, type Connection } from './hub.js';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export interface RelayServerOptions {
  store: Store;
  pubsub: PubSub;
}

export function createRelayServer({ store, pubsub }: RelayServerOptions): Server {
  const pairing = new PairingService(store);
  const hub = new ConnectionHub(store, pubsub);

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
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      res.status(200).json(session);
    })
  );

  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
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

  wss.on('connection', (ws, req) => {
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
            } catch {
              // Malformed or unauthorized message — silently dropped for v1.
            }
          })();
        });

        ws.on('close', () => hub.unregister(device.id));
      } catch {
        // Unexpected error during setup (e.g., store failure) — close cleanly.
        ws.close(1011, 'Internal error');
      }
    })();
  });

  return httpServer;
}
