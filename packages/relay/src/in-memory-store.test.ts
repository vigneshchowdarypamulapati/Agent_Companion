import { InMemoryStore } from './in-memory-store.js';
import { runStoreContractTests } from './store-contract-tests.js';

runStoreContractTests('InMemoryStore', (now) => new InMemoryStore(now));
