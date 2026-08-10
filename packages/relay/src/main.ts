import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import { WebPushSender } from './web-push-sender.js';

const PORT = Number(process.env.COMPANION_RELAY_PORT ?? 8787);
const HOST = process.env.COMPANION_RELAY_HOST ?? '0.0.0.0';

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

const store = new InMemoryStore();
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
