import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  RelayMessage,
  RequestPairingCodeRequest,
  ClaimPairingRequest,
  PollPairingRequest,
  RegisterBrowserRequest,
  PushSubscriptionPayload,
} from '@companion/protocol';
import { ZodError } from 'zod';
import type { Device, Store } from './store.js';
import type { PubSub } from './pubsub.js';
import type { IdentityVerifier } from './identity-verifier.js';
import { PairingService } from './pairing.js';
import { ConnectionHub, type Connection } from './hub.js';
import type { PushSender } from './push-sender.js';
import { RateLimiter } from './rate-limiter.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

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
  identityVerifier: IdentityVerifier;
  pushSender?: PushSender;
  vapidPublicKey?: string;
}

export async function createRelayServer({
  store,
  pubsub,
  identityVerifier,
  pushSender,
  vapidPublicKey,
}: RelayServerOptions): Promise<Server> {
  const pairing = new PairingService(store);
  const hub = new ConnectionHub(store, pubsub, undefined, undefined, pushSender);
  await hub.start();

  // A pairing code is 6 digits (10^6) and lives 5 minutes. Unthrottled, that
  // space is brute-forceable inside one code's lifetime by anyone who can sign
  // up (signup is public), and a hit hijacks a stranger's daemon onto the
  // attacker's account — so /pairing/claim is capped per calling device.
  // request-code and register-browser are capped per IP simply to keep an
  // anonymous caller from filling the pairing-code space or the devices table.
  // Caveat on the two IP-keyed limits: behind a reverse proxy, `req.ip` is the
  // proxy's address unless Express's `trust proxy` is enabled, which would make
  // those two caps effectively global. That is deliberately not enabled here —
  // trusting X-Forwarded-For without knowing the real hop count lets a client
  // forge its own key, which is strictly worse than a shared bucket. Revisit
  // together, once there is a known deployment topology to configure it from.
  const claimLimiter = new RateLimiter(10, FIVE_MINUTES_MS);
  const requestCodeLimiter = new RateLimiter(20, FIVE_MINUTES_MS);
  const registerBrowserLimiter = new RateLimiter(10, ONE_HOUR_MS);

  const app = express();
  app.use(express.json());

  app.post(
    '/pairing/request-code',
    asyncHandler(async (req, res) => {
      if (!requestCodeLimiter.attempt(req.ip ?? 'unknown')) {
        res.status(429).json({ error: 'Too many pairing attempts, try again later' });
        return;
      }
      const { deviceName } = RequestPairingCodeRequest.parse(req.body);
      const result = await pairing.requestPairingCode(deviceName);
      res.status(201).json(result);
    })
  );

  app.post(
    '/pairing/claim',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (!claimLimiter.attempt(device.id)) {
        res.status(429).json({ error: 'Too many pairing attempts, try again later' });
        return;
      }
      const { code } = ClaimPairingRequest.parse(req.body);
      const result = await pairing.claimPairingCode(code, device.userId);
      if (result === 'not_found') {
        res.status(404).json({ error: 'Invalid pairing code' });
        return;
      }
      if (result === 'expired') {
        res.status(410).json({ error: 'Pairing code expired' });
        return;
      }
      if (result === 'already_claimed') {
        res.status(409).json({ error: 'Pairing code already claimed' });
        return;
      }
      if (result === 'daemon_exists') {
        res.status(409).json({ error: 'Account already has a paired daemon — unpair it first' });
        return;
      }
      res.status(200).json({ ok: true });
    })
  );

  app.post(
    '/pairing/poll',
    asyncHandler(async (req, res) => {
      const { deviceCode } = PollPairingRequest.parse(req.body);
      const result = await pairing.pollPairingCode(deviceCode);
      res.status(200).json(result);
    })
  );

  app.post(
    '/devices/register-browser',
    asyncHandler(async (req, res) => {
      if (!registerBrowserLimiter.attempt(req.ip ?? 'unknown')) {
        res.status(429).json({ error: 'Too many pairing attempts, try again later' });
        return;
      }
      const header = req.header('authorization');
      const [scheme, clerkToken] = header?.split(' ') ?? [];
      if (!clerkToken || scheme.toLowerCase() !== 'bearer') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const identity = await identityVerifier.verifyToken(clerkToken);
      if (!identity) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { deviceName } = RegisterBrowserRequest.parse(req.body);
      const user = await store.getOrCreateUserByClerkId(identity.clerkUserId, identity.email);
      const result = await pairing.registerBrowserDevice(user.id, deviceName);
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
      const sessions = await store.getActiveSessionsForUser(device.userId);
      res.status(200).json(sessions);
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

  app.post(
    '/sessions/:id/dismiss',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await store.dismissSession(req.params.id, device.userId);
      if (result === 'not_found' || result === 'forbidden') {
        // Same response for both, like GET /sessions/:id: a non-owner cannot
        // distinguish "doesn't exist" from "exists but isn't theirs."
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      if (result === 'not_stopped') {
        res.status(409).json({ error: 'Session is not stopped' });
        return;
      }
      res.status(200).json({ ok: true });
    })
  );

  app.get(
    '/devices/me',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      res.status(200).json({
        id: device.id,
        type: device.type,
        name: device.name,
        createdAt: device.createdAt,
      });
    })
  );

  app.post(
    '/devices/unpair',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      await store.deleteDevice(device.id);
      hub.disconnectDevice(device.id);
      res.status(200).json({ ok: true });
    })
  );

  app.get(
    '/push/vapid-public-key',
    asyncHandler(async (_req, res) => {
      if (!vapidPublicKey) {
        res.status(404).json({ error: 'Push notifications are not configured on this relay' });
        return;
      }
      res.status(200).json({ publicKey: vapidPublicKey });
    })
  );

  app.post(
    '/devices/push-subscription',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const subscription = PushSubscriptionPayload.parse(req.body);
      await store.setPushSubscription(device.id, subscription);
      res.status(200).json({ ok: true });
    })
  );

  app.delete(
    '/devices/push-subscription',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      await store.setPushSubscription(device.id, undefined);
      res.status(200).json({ ok: true });
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.message });
      return;
    }
    // Anything else (a Postgres/Drizzle error, a network failure, etc.) is an
    // unexpected server-side failure, not a client mistake. The previous
    // blanket 400 both misclassified real outages as client errors and leaked
    // internal detail (SQL text, bound parameter values like a device's token
    // hash) into the response body — log the detail server-side only.
    console.error('Unhandled relay error:', err);
    res.status(500).json({ error: 'Internal server error' });
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
          close: () => ws.close(4403, 'Device unpaired'),
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
