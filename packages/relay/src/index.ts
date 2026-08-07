import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';

const PORT = Number(process.env.COMPANION_RELAY_PORT ?? 8787);
const HOST = process.env.COMPANION_RELAY_HOST ?? '0.0.0.0';

const store = new InMemoryStore();
const pubsub = new InMemoryPubSub();
const httpServer = createRelayServer({ store, pubsub });

httpServer.listen(PORT, HOST, () => {
  console.log(`Companion relay listening on http://${HOST}:${PORT}`);
});
