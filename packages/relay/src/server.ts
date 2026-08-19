import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DaemonToRelayMessage,
  BrowserToRelayMessage,
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
  /** Express `trust proxy` hop count — how many reverse proxies/load balancers sit in
   * front of this relay in the real deployment. Defaults to 0 (trust nothing). */
  trustProxyHops?: number;
  /** Origins allowed to make cross-origin requests (the web app's own origin(s)).
   * Defaults to the Vite dev server's default origin, matching the relay's own
   * default local-dev port pairing in .env.example. */
  corsOrigins?: string[];
  /** Overrides for the WS heartbeat/payload knobs below — see their doc comments for the
   * production defaults and the reasoning behind them. Exists so tests can run the heartbeat
   * loop on a short fake-timer interval and probe maxPayload without sending a real 1 MiB
   * frame, without changing what actually ships. */
  heartbeatIntervalMs?: number;
  heartbeatMaxMissedPongs?: number;
  maxPayloadBytes?: number;
}

const DEFAULT_CORS_ORIGINS = ['http://localhost:5173'];

/**
 * How often the relay pings every open connection (daemon or browser), using the `ws` library's
 * native ping/pong control frames — not an application-level "heartbeat" message — so a
 * TCP-level-open-but-actually-dead socket (a laptop that slept, a phone's radio going silent
 * without a clean FIN, a NAT/proxy that dropped the mapping) is detected instead of silently
 * swallowing every event/command sent to it. 30s is short enough that a dead connection doesn't
 * sit undetected for an unreasonable time (see DEFAULT_HEARTBEAT_MAX_MISSED_PONGS for the
 * resulting worst-case detection latency, which stacks with hub.ts's own ~30s daemon-disconnect
 * grace period before an orphaned session is actually marked stopped), and long enough that
 * battery-conscious mobile radios/background timers aren't kept awake by constant traffic.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How many consecutive ping cycles may pass with no pong before a connection is terminated. 1
 * would false-positive on a single delayed pong (a brief GC pause, a momentary radio hiccup on
 * mobile). With this loop's structure — each tick checks whether the *previous* ping ever got a
 * pong, then sends the next one — confirming N misses takes N+1 ticks (the first ping needs a
 * full interval to even be judged late), so 2 misses bounds worst-case detection at 3x the
 * interval (~90s here) after the connection actually went dead: tolerant enough not to kill a
 * flaky-but-alive mobile connection, bounded enough not to leave a truly dead one undetected for
 * long.
 */
const DEFAULT_HEARTBEAT_MAX_MISSED_PONGS = 2;

/**
 * Upper bound on a single WS frame. 1 MiB comfortably fits the largest realistic session event
 * — a `tool_use`/`tool_result` carrying a big file diff or command output is sized in the
 * daemon's own OutboundBuffer doc comments (outbound-buffer.ts) as "a few hundred KB" at most —
 * while still bounding how much memory/CPU a single malicious or buggy frame can force the
 * relay to spend decompressing and JSON-parsing before validation ever runs.
 */
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB

export async function createRelayServer({
  store,
  pubsub,
  identityVerifier,
  pushSender,
  vapidPublicKey,
  trustProxyHops,
  corsOrigins,
  heartbeatIntervalMs,
  heartbeatMaxMissedPongs,
  maxPayloadBytes,
}: RelayServerOptions): Promise<Server> {
  const resolvedHeartbeatIntervalMs = heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const resolvedHeartbeatMaxMissedPongs = heartbeatMaxMissedPongs ?? DEFAULT_HEARTBEAT_MAX_MISSED_PONGS;
  const resolvedMaxPayloadBytes = maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const pairing = new PairingService(store);
  const hub = new ConnectionHub(store, pubsub, undefined, undefined, pushSender);
  await hub.start();

  // A pairing code is 8 Crockford-base32 characters (40 bits) and lives 5
  // minutes; a hit hijacks a stranger's daemon onto the attacker's account
  // (signup is public, so "anyone" includes the attacker). /pairing/claim
  // is defended by three independent layers, each closing a gap the others
  // leave open:
  //   1. claimLimiter below — in-memory, 10/5min, keyed by the calling
  //      device's *account* (device.userId), not IP: it runs
  //      post-authentication, so the account is already known, and this is
  //      strictly tighter than keying by device (an account can't buy more
  //      claim budget by registering extra browser devices). Fast to check,
  //      but resets on every process restart/redeploy.
  //   2. store.isClaimRateLimited / store.recordFailedClaim — persistent,
  //      CLAIM_FAILURE_LIMIT/CLAIM_FAILURE_WINDOW_MS (see store.ts), also
  //      keyed by account. This is what actually bounds a *sustained* online
  //      guessing attack: it survives restarts/redeploys, unlike (1). Only
  //      not_found/expired results count as failures (see store.ts for why)
  //      — checked *before* the code is even looked up, so a rate-limited
  //      account's 429 never depends on whether the submitted code exists.
  //   3. Store.claimPairingCode / MAX_PAIRING_CODE_ATTEMPTS — per-*code*,
  //      not per-account: bounds repeated re-claim attempts against a
  //      specific code someone has already obtained by some other means. It
  //      cannot bound blind guessing (a wrong guess matches no row at all),
  //      which is what (1) and (2) are for.
  // - /devices/register-browser's real control is a limiter keyed by the
  //   *verified Clerk identity*, checked immediately after
  //   `identityVerifier.verifyToken()` succeeds and before any registration
  //   work happens. That limiter doesn't touch `req.ip` at all, so it's
  //   completely independent of proxy topology. A separate, much looser
  //   IP-keyed limiter runs pre-auth, purely to blunt a flood of garbage
  //   tokens before paying for a Clerk round-trip — it is not meant to be a
  //   precise per-user quota.
  // - /pairing/request-code has no identity to key by at all (it's how an
  //   anonymous daemon bootstraps before any auth exists), so IP is the only
  //   signal available and there's no way around that. Its accuracy behind a
  //   proxy depends entirely on Express's `trust proxy` being configured to
  //   the real hop count via COMPANION_RELAY_TRUST_PROXY (see main.ts), which
  //   defaults to trusting nothing — the safe default when the topology is
  //   unknown or there is no proxy at all.
  const claimLimiter = new RateLimiter(10, FIVE_MINUTES_MS);
  const requestCodeLimiter = new RateLimiter(20, FIVE_MINUTES_MS);
  const registerBrowserPreAuthLimiter = new RateLimiter(60, FIVE_MINUTES_MS);
  const registerBrowserAccountLimiter = new RateLimiter(10, ONE_HOUR_MS);

  const app = express();
  const resolvedTrustProxyHops = trustProxyHops ?? 0;
  app.set('trust proxy', resolvedTrustProxyHops);
  app.use(cors({ origin: corsOrigins ?? DEFAULT_CORS_ORIGINS }));
  app.use(express.json());

  // Catches the operator who deployed behind a proxy but left (or set)
  // COMPANION_RELAY_TRUST_PROXY at 0: X-Forwarded-For is arriving but
  // nothing is configured to trust it, so req.ip is silently wrong and
  // every IP-keyed rate limiter is one shared bucket for all clients (see
  // main.ts / trust-proxy.ts for the full story). Logged once per server
  // instance — in a real deployment that's once per process — not once per
  // request, since a per-request log line would itself be a trivial DoS
  // amplifier for whoever is sending the header.
  let hasWarnedAboutUntrustedForwardedFor = false;
  app.use((req, _res, next) => {
    if (
      resolvedTrustProxyHops === 0 &&
      !hasWarnedAboutUntrustedForwardedFor &&
      req.header('x-forwarded-for') !== undefined
    ) {
      hasWarnedAboutUntrustedForwardedFor = true;
      console.warn(
        'X-Forwarded-For header received but COMPANION_RELAY_TRUST_PROXY is 0 (or unset): ' +
          'this relay trusts no proxy hops, so req.ip is the raw socket address, not this ' +
          'header. If this relay is actually deployed behind a proxy/load balancer, set ' +
          'COMPANION_RELAY_TRUST_PROXY to the real hop count now — every IP-keyed rate ' +
          'limiter is currently collapsed into a single shared bucket for all clients. ' +
          '(This warning is logged once per process and then suppressed.)'
      );
    }
    next();
  });

  /**
   * Unauthenticated liveness probe for the hosting platform (Render, Fly, etc.), which needs a
   * cheap endpoint it can poll to decide whether this instance is up. Every other route on this
   * relay requires a bearer token, so without this a platform health check would see 401s and
   * conclude the service is broken.
   *
   * Deliberately reports only that the process is serving HTTP. It does NOT check the database:
   * a health check that fails on a transient Neon blip would have the platform kill and restart a
   * relay that is otherwise fine, dropping every live daemon and browser socket to no purpose —
   * turning a brief query failure into a full connection reset for everyone. Store failures are
   * already surfaced where they matter (routing paths return typed errors, and the daemon buffers
   * and replays events across a disconnect), so restarting is the wrong remedy here.
   *
   * Returns nothing about configuration, versions, connection counts, or environment: it is
   * reachable by anyone on the internet, so it says only what an unauthenticated caller could
   * already learn by observing that the port answers at all.
   */
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

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
      if (!claimLimiter.attempt(device.userId)) {
        res.status(429).json({ error: 'Too many pairing attempts, try again later' });
        return;
      }
      // Checked before the code is parsed/looked up at all, so this 429
      // never depends on — and can't leak anything about — the code the
      // caller submitted.
      if (await store.isClaimRateLimited(device.userId)) {
        res.status(429).json({ error: 'Too many pairing attempts, try again later' });
        return;
      }
      const { code } = ClaimPairingRequest.parse(req.body);
      const result = await pairing.claimPairingCode(code, device.userId);
      // Only these two outcomes are what a blind guess actually produces
      // (see CLAIM_FAILURE_LIMIT in store.ts) — already_claimed/daemon_exists
      // carry no guessing signal and are excluded so ordinary friction
      // (a double-tapped claim, retrying after already having a daemon)
      // never counts against this account's durable failure budget.
      if (result === 'not_found' || result === 'expired') {
        await store.recordFailedClaim(device.userId);
      }
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
      if (!registerBrowserPreAuthLimiter.attempt(req.ip ?? 'unknown')) {
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
      if (!registerBrowserAccountLimiter.attempt(identity.clerkUserId)) {
        res.status(429).json({ error: 'Too many pairing attempts, try again later' });
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

  app.get(
    '/devices/daemon-status',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const daemon = await store.getDaemonDeviceForUser(device.userId);
      if (!daemon) {
        res.status(200).json({ paired: false });
        return;
      }
      res.status(200).json({
        paired: true,
        name: daemon.name,
        connected: hub.isDeviceConnected(daemon.id),
        pairedAt: daemon.createdAt,
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
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: resolvedMaxPayloadBytes });

  // An 'error' event with no listener is an uncaught exception, which terminates the process.
  // This also covers a frame exceeding maxPayload: `ws` surfaces that as an 'error' on the
  // socket (and aborts/closes it itself), not a thrown exception, so the frame is rejected
  // without crashing the connection or the process.
  wss.on('error', () => {});

  // Native ws ping/pong liveness check (see DEFAULT_HEARTBEAT_* doc comments above for the
  // interval/miss-count reasoning). Tracked per-socket via a WeakMap rather than a property
  // stashed on the `ws` instance, so this stays out of `ws`'s own type surface. A connection
  // that misses `resolvedHeartbeatMaxMissedPongs` consecutive pongs is terminated via
  // `ws.terminate()`, which — like any other socket close — fires the 'close' listener
  // registered below, running the exact same `hub.unregister` cleanup (including the
  // daemon-disconnect grace period in hub.ts) as a normal client-initiated close. There is
  // deliberately no separate/shortcut cleanup path for a heartbeat-triggered termination.
  const missedPongsBySocket = new WeakMap<WebSocket, number>();
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const missed = missedPongsBySocket.get(ws) ?? 0;
      if (missed >= resolvedHeartbeatMaxMissedPongs) {
        ws.terminate();
        continue;
      }
      missedPongsBySocket.set(ws, missed + 1);
      ws.ping();
    }
  }, resolvedHeartbeatIntervalMs);
  // `wss.close()` (unlike `httpServer.close()`) is never called anywhere in this codebase — the
  // relay just closes its one httpServer on shutdown/test teardown. Tying cleanup to
  // httpServer's 'close' (rather than wss's) guarantees this interval is always cleared,
  // including in every existing test that only closes httpServer. `unref()` is a second,
  // redundant safety net in case some caller closes neither.
  httpServer.on('close', () => clearInterval(heartbeatInterval));
  heartbeatInterval.unref();

  wss.on('connection', (ws, req) => {
    // Attached first, before any async work, so a malformed frame arriving immediately after
    // the handshake cannot crash the process. The 'close' handler still fires afterwards.
    ws.on('error', () => {});

    missedPongsBySocket.set(ws, 0);
    // Any pong — solicited by our own ping or not — is evidence the connection is alive.
    ws.on('pong', () => missedPongsBySocket.set(ws, 0));

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
              const rawFrame = JSON.parse(raw.toString());
              if (device.type === 'daemon') {
                const parsed = DaemonToRelayMessage.parse(rawFrame);
                if (parsed.kind === 'event') {
                  await hub.routeFromDaemon(connection, parsed.sessionId, parsed.event, parsed.deliverySeq);
                } else if (parsed.kind === 'command_ack') {
                  await hub.routeCommandAck(connection, parsed);
                } else if (parsed.kind === 'rpc_response') {
                  await hub.routeRpcResponse(connection, parsed);
                }
              } else {
                const parsed = BrowserToRelayMessage.parse(rawFrame);
                if (parsed.kind === 'command') {
                  await hub.routeFromBrowser(connection, parsed.sessionId, parsed.commandId, parsed.command);
                } else if (parsed.kind === 'rpc_request') {
                  await hub.routeRpcRequest(connection, parsed.requestId, parsed.method, parsed.params);
                }
              }
            } catch (err) {
              // Diagnostic frame — deliberately not part of any of the directional wire-protocol schemas.
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
