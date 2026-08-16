import { beforeAll, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { createDbClient, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { PostgresStore } from './postgres-store.js';
import { runStoreContractTests } from './store-contract-tests.js';
import { pointsAtSameDatabase } from './test-db-guard.js';

// This suite runs a destructive TRUNCATE against its database before every
// test case (see beforeEach below), so it must never be able to point at a
// real dev/prod database by accident. It deliberately reads
// COMPANION_TEST_DATABASE_URL — never DATABASE_URL — and refuses to fall
// back: a stale or misconfigured DATABASE_URL in some shell must never be
// able to wipe real data just because this suite happened to run. There is
// also no silent skip when the variable is missing — a skipped store suite
// would hide real regressions in PostgresStore.
//
// vitest.config.ts loads packages/relay/.env, so setting
// COMPANION_TEST_DATABASE_URL there (to a separate, isolated Neon branch's
// connection string — Neon branching is free and instant, see
// docs/superpowers/specs/2026-08-11-persistent-storage-design.md) is enough
// for it to be picked up automatically.
const TEST_DATABASE_URL = process.env.COMPANION_TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error(
    'COMPANION_TEST_DATABASE_URL is not set. postgres-store.test.ts truncates every ' +
      'table before each test case, so it refuses to run against DATABASE_URL or any ' +
      'other implicit default — that is exactly the hazard this check exists to ' +
      'prevent. Provision an isolated Neon branch for testing (Neon branching is free ' +
      'and instant; see docs/superpowers/specs/2026-08-11-persistent-storage-design.md), ' +
      'then set COMPANION_TEST_DATABASE_URL to its connection string in packages/relay/.env.'
  );
}

// Checked again here, at module scope, before beforeAll ever creates a pool
// or runs migrations — not just in beforeEach immediately before the
// TRUNCATE. beforeAll below runs migrations, which themselves write schema
// changes to whatever database TEST_DATABASE_URL resolves to; catching an
// operator-error identical value only in beforeEach would let that
// migration run against a real dev/prod database first. This check and the
// one in beforeEach are intentionally redundant (see the comment there).
//
// I4: uses pointsAtSameDatabase rather than a raw `===`, because two
// byte-different connection strings can still address the same physical
// database — Neon (this project's Postgres host) hands out both a pooled
// hostname (`...-pooler...`) and a direct hostname for the same database,
// and query params/credentials can differ too. A byte comparison alone
// would pass in exactly the case this guard exists to catch. See
// test-db-guard.ts for the comparison itself and its test coverage.
if (process.env.DATABASE_URL && pointsAtSameDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL)) {
  throw new Error(
    'COMPANION_TEST_DATABASE_URL resolves to the same database as DATABASE_URL (same host — ' +
      'ignoring a Neon pooler suffix — and same database name, regardless of query params or ' +
      'credentials). Refusing to run — this suite migrates and then truncates its database ' +
      'before every test, and must never do that against what may be a real dev/prod ' +
      'database. Point COMPANION_TEST_DATABASE_URL at a separate, isolated Neon branch instead.'
  );
}

let db: Db;
let pool: Pool;

beforeAll(async () => {
  ({ pool, db } = createDbClient(TEST_DATABASE_URL));
  await runMigrations(db);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Independent, redundant guard: even though the module-level check above
  // already refuses to run with COMPANION_TEST_DATABASE_URL unset or
  // resolving to the same database as DATABASE_URL, this catches the
  // operator who "helpfully" points both env vars at the same database —
  // that would still send the TRUNCATE below at DATABASE_URL. Checked
  // fresh immediately before every TRUNCATE, not just once at import time.
  if (process.env.DATABASE_URL && pointsAtSameDatabase(TEST_DATABASE_URL, process.env.DATABASE_URL)) {
    throw new Error(
      'COMPANION_TEST_DATABASE_URL resolves to the same database as DATABASE_URL. Refusing ' +
        'to run the destructive TRUNCATE below against what may be a real dev/prod database. ' +
        'Point COMPANION_TEST_DATABASE_URL at a separate, isolated Neon branch instead.'
    );
  }
  await db.execute(
    sql`TRUNCATE TABLE users, devices, pairing_codes, claim_failures, sessions, session_events RESTART IDENTITY CASCADE`
  );
});

runStoreContractTests('PostgresStore', (now) => new PostgresStore(db, now));
