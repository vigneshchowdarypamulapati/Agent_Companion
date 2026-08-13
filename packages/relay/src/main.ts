import { createRelayServer } from './server.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import { WebPushSender } from './web-push-sender.js';
import { createDbClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { PostgresStore } from './postgres-store.js';
import { ClerkIdentityVerifier } from './identity-verifier.js';

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

const PORT = Number(process.env.COMPANION_RELAY_PORT ?? 8787);
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

let trustProxyHops = 0;
const trustProxyRaw = process.env.COMPANION_RELAY_TRUST_PROXY;
if (trustProxyRaw !== undefined) {
  const parsed = Number(trustProxyRaw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      'COMPANION_RELAY_TRUST_PROXY must be a non-negative integer (the number of reverse ' +
        'proxies/load balancers in front of this relay) if set at all. Leave it unset if ' +
        'there is no proxy or the topology is unknown.'
    );
  }
  trustProxyHops = parsed;
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
