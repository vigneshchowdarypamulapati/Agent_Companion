import { createRelayServer } from './server.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import { WebPushSender } from './web-push-sender.js';
import { createDbClient } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { PostgresStore } from './postgres-store.js';

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

const { db } = createDbClient(DATABASE_URL);
await runMigrations(db);

const store = new PostgresStore(db);
const pubsub = new InMemoryPubSub();
const httpServer = await createRelayServer({
  store,
  pubsub,
  pushSender,
  vapidPublicKey: pushSender ? vapidPublicKey : undefined,
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Companion relay listening on http://${HOST}:${PORT}`);
});
