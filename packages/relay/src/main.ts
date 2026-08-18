import { createRelayServer } from './server.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import { WebPushSender } from './web-push-sender.js';
import { createDbClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { PostgresStore } from './postgres-store.js';
import { ClerkIdentityVerifier } from './identity-verifier.js';
import { resolveTrustProxyHops } from './trust-proxy.js';

// .env isn't checked in (it holds a real Neon connection string). Loading
// it here means `node dist/main.js` and `npm start` both just work locally
// without extra flags; a missing .env is fine — real deployments set
// DATABASE_URL directly in the environment instead. None of the imports
// above read env vars at their own module-load time, so it doesn't matter
// that this runs after them — every env-dependent read in this file
// happens below this line anyway.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file present — fine in production
}

// `PORT` is the near-universal platform convention (Render, Railway, Fly, Heroku all inject it
// and route external traffic to whatever port the process binds). It's accepted as a fallback so
// the relay runs on those hosts with no relay-specific configuration at all, while
// COMPANION_RELAY_PORT still wins when set — a deployment that deliberately pins a port should
// not be silently overridden by the platform's injected one.
const PORT = Number(process.env.COMPANION_RELAY_PORT ?? process.env.PORT ?? 8787);
// Must stay 0.0.0.0 (not localhost) on every container platform: binding the loopback interface
// makes the process unreachable from the host's proxy, which presents as a deploy that starts
// cleanly, passes its own logs, and then fails every health check.
const HOST = process.env.COMPANION_RELAY_HOST ?? '0.0.0.0';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required — set it to a Postgres connection string. ' +
      'See packages/relay/.env.example for local development.'
  );
}

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  throw new Error(
    'CLERK_SECRET_KEY is required — set it to your Clerk application\'s secret key. ' +
      'See packages/relay/.env.example for local development.'
  );
}

// See trust-proxy.ts for why there is no safe default and why production
// requires this to be set explicitly.
const trustProxyHops = resolveTrustProxyHops(
  process.env.COMPANION_RELAY_TRUST_PROXY,
  process.env.NODE_ENV
);

let corsOrigins: string[] | undefined;
const corsOriginsRaw = process.env.COMPANION_RELAY_CORS_ORIGIN;
if (corsOriginsRaw !== undefined) {
  corsOrigins = corsOriginsRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (corsOrigins.length === 0) {
    throw new Error(
      'COMPANION_RELAY_CORS_ORIGIN must be a comma-separated list of at least one origin ' +
        '(the web app\'s own origin(s)) if set at all. Leave it unset to allow the default ' +
        'local dev origin only.'
    );
  }
}

const vapidPublicKey = process.env.COMPANION_RELAY_VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.COMPANION_RELAY_VAPID_PRIVATE_KEY;
const vapidSubject = process.env.COMPANION_RELAY_VAPID_SUBJECT;

const pushSender =
  vapidPublicKey && vapidPrivateKey && vapidSubject
    ? new WebPushSender({ vapidPublicKey, vapidPrivateKey, vapidSubject })
    : undefined;

if (!pushSender) {
  console.log(
    'Push notifications are disabled: set COMPANION_RELAY_VAPID_PUBLIC_KEY, ' +
      'COMPANION_RELAY_VAPID_PRIVATE_KEY, and COMPANION_RELAY_VAPID_SUBJECT to enable them.'
  );
}

const { pool, db } = createDbClient(DATABASE_URL);
await runMigrations(db);

const store = new PostgresStore(db);
const pubsub = new InMemoryPubSub();
const identityVerifier = new ClerkIdentityVerifier(CLERK_SECRET_KEY);
const httpServer = await createRelayServer({
  store,
  pubsub,
  identityVerifier,
  pushSender,
  vapidPublicKey: pushSender ? vapidPublicKey : undefined,
  trustProxyHops,
  corsOrigins,
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Companion relay listening on http://${HOST}:${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
