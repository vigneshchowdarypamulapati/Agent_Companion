import { beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDbClient, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { PostgresStore } from './postgres-store.js';
import { runStoreContractTests } from './store-contract-tests.js';

// vitest.config.ts (Step 5) already loads packages/relay/.env, so
// DATABASE_URL is always set here in practice — no local fallback needed
// or wanted, since there's no local database to fall back to.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — check packages/relay/.env');
}
const DATABASE_URL = process.env.DATABASE_URL;

let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ pool, db } = createDbClient(DATABASE_URL));
  await runMigrations(db);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE users, devices, pairing_codes, sessions, session_events RESTART IDENTITY CASCADE`);
});

runStoreContractTests('PostgresStore', (now) => new PostgresStore(db, now));
