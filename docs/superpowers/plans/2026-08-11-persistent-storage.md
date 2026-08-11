# Persistent Storage (Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `InMemoryStore` with a `PostgresStore` that implements the exact same `Store` interface, backed by a real, durable Neon Postgres database (the same project for local dev, tests, and production at this stage), so a relay restart no longer wipes every paired device and session.

**Architecture:** Drizzle ORM (`drizzle-orm` + `drizzle-kit`) over the standard `pg` node-postgres driver, one table per `Store` record type. `PostgresStore` is a drop-in swap behind the existing `Store` port — `hub.ts`/`pairing.ts`/`server.ts` don't change at all, only how `main.ts` constructs the store. `InMemoryStore` stays in the codebase as a fast test double for non-storage tests; it is never used by the running relay in any environment.

**Tech Stack:** `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `pg@8.23.0`, `@types/pg@8.21.0`, Neon Postgres (no local database engine — `DATABASE_URL` points at the real Neon project everywhere, including tests).

## Global Constraints

- `PostgresStore` implements `Store` (`packages/relay/src/store.ts`) exactly — no interface changes.
- No change to any relay HTTP/WebSocket contract, request/response shape, or status code. `hub.ts`, `pairing.ts`, and `server.ts` are not modified by this plan.
- `createdAt`/`expiresAt`/`startedAt`/`lastEventAt` are plain JS numbers (epoch-ms) at every `Store` method boundary, not `Date` objects or strings — enforced via Drizzle's `bigint(..., { mode: 'number' })`.
- No FK constraints on `devices.userId`, `pairingCodes.userId`, `sessions.userId`, `sessions.daemonDeviceId`, or `sessionEvents.sessionId` — none of these may reject an insert/delete because a referenced row doesn't exist. `users.email` and `devices.tokenHash` stay UNIQUE.
- The full existing `in-memory-store.test.ts` suite (all 20 cases, unmodified in behavior) must pass verbatim against `PostgresStore` via a shared contract-test function — if a case needs a behavior change to pass, that's a signal of an implementation deviation, not a wrong test.
- `DATABASE_URL` is required in every environment the relay actually runs in — `main.ts` throws and fails to start if it's unset. `InMemoryStore` is kept only as a test double for non-storage tests (`hub.test.ts`, `server.test.ts`, `pairing`-related tests), never as a runtime fallback.
- Real Postgres (the actual Neon project, via `DATABASE_URL` — no local database engine, no Docker) backs `npm test`, not just production — `PostgresStore`'s own tests run against a real Postgres engine, not a mock.
- `packages/relay/.env` (gitignored, already created with the real Neon `DATABASE_URL`) must never be read into a commit, a report file, or any subagent's returned text — treat its contents as a live credential.

---

### Task 1: Database schema, migrations, and Neon connection

**Files:**
- Modify: `packages/relay/package.json`
- Modify: `packages/relay/vitest.config.ts`
- Create: `packages/relay/src/db/schema.ts`
- Create: `packages/relay/src/db/client.ts`
- Create: `packages/relay/src/db/migrate.ts`
- Create: `packages/relay/src/db/schema.test.ts`
- Create: `packages/relay/drizzle.config.ts`
- Create: `packages/relay/.env.example`
- Generate: `packages/relay/drizzle/*.sql` and `packages/relay/drizzle/meta/*` (via `drizzle-kit generate`, not hand-written)

**Already done, before this task starts:** `packages/relay/.env` exists (gitignored) with a real Neon pooled connection string in `DATABASE_URL`, and `.gitignore` already has a `.env` line. Do not create, overwrite, or print the contents of `packages/relay/.env` — read `DATABASE_URL` from it the normal way (via `process.env`, loaded through the commands below), never by opening the file.

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task).
- Produces: `schema.ts` exports `users`, `devices`, `pairingCodes`, `sessions`, `sessionEvents` (Drizzle `pgTable` definitions). `client.ts` exports `createDbClient(connectionString: string): { pool: Pool; db: Db }` and the type `Db = NodePgDatabase<typeof schema>`. `migrate.ts` exports `runMigrations(db: Db): Promise<void>`. All three are consumed by Task 2 (`postgres-store.ts`, `postgres-store.test.ts`) and Task 3 (`main.ts`).

- [ ] **Step 1: Add dependencies**

In `packages/relay/package.json`, change `dependencies` and `devDependencies` to:

```json
{
  "name": "@companion/relay",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/main.js",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@companion/protocol": "*",
    "drizzle-orm": "^0.45.2",
    "express": "^4.21.0",
    "pg": "^8.23.0",
    "web-push": "^3.6.7",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^7.0.2",
    "vitest": "^4.1.10",
    "supertest": "^7.2.2",
    "drizzle-kit": "^0.31.10",
    "@types/express": "^4.17.25",
    "@types/supertest": "^6.0.3",
    "@types/node": "^22.20.1",
    "@types/pg": "^8.21.0",
    "@types/web-push": "^3.6.4",
    "@types/ws": "^8.18.1"
  }
}
```

Run from the repo root (`D:\Companion`): `npm install`

- [ ] **Step 2: Add an `.env.example` template**

Create `packages/relay/.env.example` — a template for anyone else setting this project up, showing the expected shape without any real credential (the real one already lives in the gitignored `packages/relay/.env`, set up separately):

```
DATABASE_URL=postgresql://<user>:<password>@<host>-pooler.<region>.aws.neon.tech/<database>?sslmode=require&channel_binding=require
```

- [ ] **Step 3: Write the schema**

Create `packages/relay/src/db/schema.ts`:

```ts
import { pgTable, uuid, text, bigint, bigserial, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import type { PushSubscriptionPayload, SessionEvent } from '@companion/protocol';

// No FK from userId/daemonDeviceId/sessionId back to their owning tables,
// anywhere in this schema. Two independent reasons, both real:
//   1. daemonDeviceId specifically: InMemoryStore's deleteDevice()
//      intentionally leaves sessions pointing at a deleted device's id
//      (the disconnect-grace path in ConnectionHub is what marks those
//      sessions stopped, not device deletion) — a real FK would turn that
//      into a delete failure instead.
//   2. userId and sessionId generally: the Store interface only supports
//      one seeded user in this phase (getOrCreateDefaultUser() is a
//      singleton — there is no way to create a second real user yet), and
//      the existing contract-test suite exercises devices/sessions/events
//      created with arbitrary opaque id strings that were never inserted
//      as real rows first. InMemoryStore never validated these references
//      either, so real FK enforcement now would break behavioral parity
//      with the exact test suite this plan must keep passing unchanged.
//      Real per-user referential integrity is a multi-user-phase concern.
// Indexes (not constraints) are still added on the columns actually
// queried by userId/sessionId, since those speed up real lookups without
// asserting anything about what rows exist.

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  type: text('type', { enum: ['daemon', 'browser'] }).notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  pushSubscription: jsonb('push_subscription').$type<PushSubscriptionPayload>(),
}, (table) => ([
  index('devices_user_id_idx').on(table.userId),
]));

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  userId: uuid('user_id').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  consumed: boolean('consumed').notNull().default(false),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  daemonDeviceId: uuid('daemon_device_id').notNull(),
  projectPath: text('project_path').notNull(),
  status: text('status', { enum: ['running', 'waiting_permission', 'paused', 'stopped'] }).notNull(),
  startedAt: bigint('started_at', { mode: 'number' }).notNull(),
  lastEventAt: bigint('last_event_at', { mode: 'number' }).notNull(),
  dismissed: boolean('dismissed').notNull().default(false),
}, (table) => ([
  index('sessions_user_id_idx').on(table.userId),
]));

// seq is a bigserial (one Postgres sequence for the whole table), matching
// InMemoryStore's single global nextSeq counter shared across every
// session — not a per-session counter.
export const sessionEvents = pgTable('session_events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  sessionId: text('session_id').notNull(),
  event: jsonb('event').notNull().$type<SessionEvent>(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ([
  index('session_events_session_id_idx').on(table.sessionId),
]));
```

- [ ] **Step 4: Write the DB client and migration helpers**

Create `packages/relay/src/db/client.ts`:

```ts
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDbClient(connectionString: string): { pool: Pool; db: Db } {
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema });
  return { pool, db };
}
```

Create `packages/relay/src/db/migrate.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.js';

// packages/relay/src/db/migrate.ts (or dist/db/migrate.js after build) is
// always two directories below packages/relay/, so '../../drizzle'
// resolves to packages/relay/drizzle/ from either location.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
```

- [ ] **Step 5: Write the Drizzle Kit config, and load `.env` for tests**

Create `packages/relay/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

// .env isn't checked in, so drizzle-kit CLI invocations (which don't go
// through vitest.config.ts's own loadEnvFile call) need to load it here
// too. Missing .env is fine — real deployments set DATABASE_URL directly.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file present — fine in production
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to run drizzle-kit — see packages/relay/.env.example');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
```

Also update `packages/relay/vitest.config.ts` (currently just `defineConfig({ test: { exclude: [...] } })`) to load the same `.env` file before any test file runs, so every `npm test` command below — and every later `npm test -w @companion/relay -- <pattern>` command in this plan — picks up `DATABASE_URL` automatically with no manual env setup:

```ts
import { defineConfig } from 'vitest/config';

// Tests need DATABASE_URL (the real Neon project) but .env isn't checked
// in. Loading it here means every `npm test` invocation picks it up
// automatically. Missing .env would just mean tests that need
// DATABASE_URL fail with a clear connection error — not silently skipped.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file present — fine in CI environments that set env vars directly
}

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
```

- [ ] **Step 6: Write the failing schema/migration smoke test**

Create `packages/relay/src/db/schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDbClient, type Db } from './client.js';
import type { Pool } from 'pg';
import { runMigrations } from './migrate.js';
import { users, devices, pairingCodes, sessions, sessionEvents } from './schema.js';

// vitest.config.ts (Step 5) already loads packages/relay/.env, so
// DATABASE_URL is always set here in practice — no local fallback needed
// or wanted, since there's no local database to fall back to.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — check packages/relay/.env');
}
const DATABASE_URL = process.env.DATABASE_URL;

describe('schema and migrations', () => {
  let db: Db;
  let pool: Pool;

  beforeAll(async () => {
    ({ pool, db } = createDbClient(DATABASE_URL));
    await runMigrations(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('round-trips a row through every table', async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `schema-test-${Date.now()}@example.com`, createdAt: 1 })
      .returning();
    expect(user.id).toBeDefined();

    const [device] = await db
      .insert(devices)
      .values({ userId: user.id, type: 'browser', name: 'test-device', tokenHash: `hash-${Date.now()}`, createdAt: 1 })
      .returning();
    expect(device.id).toBeDefined();

    const [pairing] = await db
      .insert(pairingCodes)
      .values({ code: `${Date.now()}`.slice(-6), userId: user.id, expiresAt: 1, consumed: false })
      .returning();
    expect(pairing.code).toBeDefined();

    const [session] = await db
      .insert(sessions)
      .values({
        id: `sess-${Date.now()}`,
        userId: user.id,
        daemonDeviceId: device.id,
        projectPath: '/tmp/project',
        status: 'running',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      })
      .returning();
    expect(session.id).toBeDefined();

    const [event] = await db
      .insert(sessionEvents)
      .values({ sessionId: session.id, event: { type: 'turn_complete', sessionId: session.id, at: 1 }, createdAt: 1 })
      .returning();
    expect(event.seq).toBeDefined();

    const found = await db.select().from(users).where(eq(users.id, user.id));
    expect(found).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test -w @companion/relay -- schema`
Expected: FAIL — `packages/relay/drizzle/` doesn't exist yet, so `runMigrations` has no migration files to apply and the tables don't exist. (`vitest.config.ts`, from Step 5, already loads `packages/relay/.env`'s `DATABASE_URL` automatically — no manual env setup needed for this or any later `npm test`/`npm run build` command in this plan.)

- [ ] **Step 8: Generate the migration**

From `packages/relay`: `npm run db:generate`

This reads `src/db/schema.ts` and writes SQL migration files plus a metadata journal under `packages/relay/drizzle/`. Open the generated `.sql` file and confirm it contains `CREATE TABLE` statements for `users`, `devices`, `pairing_codes`, `sessions`, and `session_events`, matching the columns defined in Step 3 — if any table or column is missing, `schema.ts` has a mistake to fix before continuing.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -w @companion/relay -- schema`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add packages/relay/package.json package-lock.json packages/relay/vitest.config.ts packages/relay/src/db packages/relay/drizzle.config.ts packages/relay/drizzle packages/relay/.env.example
git commit -m "feat(relay): add Postgres schema, migrations, and Neon connection"
```

---

### Task 2: `PostgresStore` implementation and shared contract tests

**Files:**
- Create: `packages/relay/src/postgres-store.ts`
- Create: `packages/relay/src/store-contract-tests.ts`
- Modify: `packages/relay/src/in-memory-store.test.ts`
- Create: `packages/relay/src/postgres-store.test.ts`

**Interfaces:**
- Consumes: `Db` type and `createDbClient(connectionString: string): { pool: Pool; db: Db }` from `./db/client.js`; `runMigrations(db: Db): Promise<void>` from `./db/migrate.js`; `users`, `devices`, `pairingCodes`, `sessions`, `sessionEvents` table definitions from `./db/schema.js` (all from Task 1). `Store`, `User`, `Device`, `PairingCode`, `SessionRecord`, `StoredSessionEvent`, `DismissSessionResult` types from `./store.js` (pre-existing).
- Produces: `PostgresStore` class implementing `Store`, constructor `(db: Db, now: () => number = Date.now)`. `runStoreContractTests(label: string, makeStore: (now?: () => number) => Store | Promise<Store>): void` — a shared vitest test-suite generator. Both consumed by Task 3's manual verification (not imported by code, just run via `npm test`).

- [ ] **Step 1: Extract the shared contract-test suite**

Create `packages/relay/src/store-contract-tests.ts` — this is the entire body of the current `in-memory-store.test.ts`, generalized to run against any `Store` implementation via a factory function instead of constructing `InMemoryStore` directly:

```ts
import { describe, it, expect } from 'vitest';
import type { Store } from './store.js';

export function runStoreContractTests(label: string, makeStore: (now?: () => number) => Store | Promise<Store>): void {
  describe(label, () => {
    it('returns the same default user on repeated calls', async () => {
      const store = await makeStore();
      const first = await store.getOrCreateDefaultUser();
      const second = await store.getOrCreateDefaultUser();
      expect(second.id).toBe(first.id);
    });

    it('creates a device and finds it by token hash', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateDefaultUser();
      const device = await store.createDevice({
        userId: user.id,
        type: 'daemon',
        name: 'laptop',
        tokenHash: 'hash-1',
      });
      const found = await store.getDeviceByTokenHash('hash-1');
      expect(found?.id).toBe(device.id);
    });

    it('returns undefined for an unknown token hash', async () => {
      const store = await makeStore();
      expect(await store.getDeviceByTokenHash('does-not-exist')).toBeUndefined();
    });

    it('deleteDevice removes the device so its token no longer authenticates', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateDefaultUser();
      const device = await store.createDevice({
        userId: user.id,
        type: 'browser',
        name: 'phone',
        tokenHash: 'hash-2',
      });

      await store.deleteDevice(device.id);

      expect(await store.getDeviceByTokenHash('hash-2')).toBeUndefined();
    });

    it('deleteDevice is a no-op for an unknown device id', async () => {
      const store = await makeStore();
      await expect(store.deleteDevice('does-not-exist')).resolves.toBeUndefined();
    });

    it('setPushSubscription stores a subscription on the device', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateDefaultUser();
      const device = await store.createDevice({
        userId: user.id,
        type: 'browser',
        name: 'phone',
        tokenHash: 'hash-3',
      });
      const subscription = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };

      await store.setPushSubscription(device.id, subscription);

      const devices = await store.getDevicesForUser(user.id);
      expect(devices.find((d) => d.id === device.id)?.pushSubscription).toEqual(subscription);
    });

    it('setPushSubscription with undefined clears an existing subscription', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateDefaultUser();
      const device = await store.createDevice({
        userId: user.id,
        type: 'browser',
        name: 'phone',
        tokenHash: 'hash-4',
      });
      await store.setPushSubscription(device.id, {
        endpoint: 'https://push.example.com/abc',
        keys: { p256dh: 'p', auth: 'a' },
      });

      await store.setPushSubscription(device.id, undefined);

      const devices = await store.getDevicesForUser(user.id);
      expect(devices.find((d) => d.id === device.id)?.pushSubscription).toBeUndefined();
    });

    it('setPushSubscription is a no-op for an unknown device id', async () => {
      const store = await makeStore();
      await expect(
        store.setPushSubscription('does-not-exist', { endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } })
      ).resolves.toBeUndefined();
    });

    it('getDevicesForUser returns only devices belonging to that user', async () => {
      const store = await makeStore();
      await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-5' });
      await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-6' });
      await store.createDevice({ userId: 'user-2', type: 'browser', name: 'intruder', tokenHash: 'hash-7' });

      const devices = await store.getDevicesForUser('user-1');

      expect(devices.map((d) => d.name).sort()).toEqual(['laptop', 'phone']);
    });

    it('a pairing code can only be consumed once', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateDefaultUser();
      const pairing = await store.createPairingCode(user.id);

      const first = await store.consumePairingCode(pairing.code);
      expect(first?.code).toBe(pairing.code);

      const second = await store.consumePairingCode(pairing.code);
      expect(second).toBeUndefined();
    });

    it('consumePairingCode returns undefined for an expired code', async () => {
      let now = 1_000_000;
      const store = await makeStore(() => now);
      const user = await store.getOrCreateDefaultUser();
      const pairing = await store.createPairingCode(user.id);

      now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute TTL

      expect(await store.consumePairingCode(pairing.code)).toBeUndefined();
    });

    it('appends and retrieves session events in order, filtered by sinceSeq', async () => {
      const store = await makeStore();
      await store.appendSessionEvent('sess-1', {
        type: 'turn_complete',
        sessionId: 'sess-1',
        at: 1,
      });
      const second = await store.appendSessionEvent('sess-1', {
        type: 'turn_complete',
        sessionId: 'sess-1',
        at: 2,
      });

      const all = await store.getSessionEvents('sess-1');
      expect(all).toHaveLength(2);

      const sinceFirst = await store.getSessionEvents('sess-1', all[0].seq);
      expect(sinceFirst).toHaveLength(1);
      expect(sinceFirst[0].seq).toBe(second.seq);
    });

    it('upsertSession and updateSessionStatus round-trip', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'running',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });
      await store.updateSessionStatus('sess-1', 'paused');

      const session = await store.getSession('sess-1');
      expect(session?.status).toBe('paused');
    });

    it("appendSessionEvent bumps the owning session's lastEventAt", async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'running',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });

      await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 42 });

      expect((await store.getSession('sess-1'))?.lastEventAt).toBe(42);
    });

    it('getActiveSessionsForUser returns every non-dismissed session for that user', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project-a',
        status: 'running',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });
      await store.upsertSession({
        id: 'sess-2',
        userId: 'user-1',
        daemonDeviceId: 'device-2',
        projectPath: '/tmp/project-b',
        status: 'waiting_permission',
        startedAt: 2,
        lastEventAt: 2,
        dismissed: false,
      });

      const active = await store.getActiveSessionsForUser('user-1');
      expect(active.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2']);
    });

    it('getActiveSessionsForUser includes a stopped session until it is dismissed', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'stopped',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });

      expect((await store.getActiveSessionsForUser('user-1')).map((s) => s.id)).toEqual(['sess-1']);

      await store.dismissSession('sess-1', 'user-1');

      expect(await store.getActiveSessionsForUser('user-1')).toEqual([]);
    });

    it('getActiveSessionsForUser only returns sessions belonging to that user', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'running',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });

      expect(await store.getActiveSessionsForUser('user-2')).toEqual([]);
    });

    it('dismissSession returns not_found for an unknown session', async () => {
      const store = await makeStore();
      expect(await store.dismissSession('does-not-exist', 'user-1')).toBe('not_found');
    });

    it('dismissSession returns forbidden for a session owned by another user', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'stopped',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });

      expect(await store.dismissSession('sess-1', 'user-2')).toBe('forbidden');
    });

    it('dismissSession returns not_stopped for a session that is still running', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'running',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });

      expect(await store.dismissSession('sess-1', 'user-1')).toBe('not_stopped');
      expect((await store.getSession('sess-1'))?.dismissed).toBe(false);
    });

    it('dismissSession marks a stopped session dismissed and returns ok', async () => {
      const store = await makeStore();
      await store.upsertSession({
        id: 'sess-1',
        userId: 'user-1',
        daemonDeviceId: 'device-1',
        projectPath: '/tmp/project',
        status: 'stopped',
        startedAt: 1,
        lastEventAt: 1,
        dismissed: false,
      });

      expect(await store.dismissSession('sess-1', 'user-1')).toBe('ok');
      expect((await store.getSession('sess-1'))?.dismissed).toBe(true);
    });
  });
}
```

- [ ] **Step 2: Point `in-memory-store.test.ts` at the shared suite**

Replace the full contents of `packages/relay/src/in-memory-store.test.ts` with:

```ts
import { InMemoryStore } from './in-memory-store.js';
import { runStoreContractTests } from './store-contract-tests.js';

runStoreContractTests('InMemoryStore', (now) => new InMemoryStore(now));
```

- [ ] **Step 3: Run the InMemoryStore suite to confirm the extraction didn't change behavior**

Run: `npm test -w @companion/relay -- in-memory-store`
Expected: PASS (all 20 cases, now running through `runStoreContractTests`)

- [ ] **Step 4: Write the failing PostgresStore contract test**

Create `packages/relay/src/postgres-store.test.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -w @companion/relay -- postgres-store`
Expected: FAIL — `./postgres-store.js` doesn't exist yet.

- [ ] **Step 6: Implement `PostgresStore`**

Create `packages/relay/src/postgres-store.ts`:

```ts
import { randomInt } from 'node:crypto';
import { and, eq, gt, gte } from 'drizzle-orm';
import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';
import type { Device, DismissSessionResult, PairingCode, SessionRecord, Store, StoredSessionEvent, User } from './store.js';
import type { Db } from './db/client.js';
import { users, devices, pairingCodes, sessions, sessionEvents } from './db/schema.js';

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_USER_EMAIL = 'you@example.com';

export class PostgresStore implements Store {
  constructor(
    private db: Db,
    private now: () => number = Date.now
  ) {}

  async getOrCreateDefaultUser(): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values({ email: DEFAULT_USER_EMAIL, createdAt: this.now() })
      .onConflictDoUpdate({ target: users.email, set: { email: DEFAULT_USER_EMAIL } })
      .returning();
    return user;
  }

  async createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device> {
    const [device] = await this.db
      .insert(devices)
      .values({ ...input, createdAt: this.now() })
      .returning();
    return { ...device, pushSubscription: device.pushSubscription ?? undefined };
  }

  async getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined> {
    const [device] = await this.db.select().from(devices).where(eq(devices.tokenHash, tokenHash));
    if (!device) return undefined;
    return { ...device, pushSubscription: device.pushSubscription ?? undefined };
  }

  /**
   * Removes only the device row. Sessions referencing this device's id as
   * daemonDeviceId are left as-is on purpose — see the comment above the
   * table definitions in db/schema.ts.
   */
  async deleteDevice(deviceId: string): Promise<void> {
    await this.db.delete(devices).where(eq(devices.id, deviceId));
  }

  async setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void> {
    await this.db
      .update(devices)
      .set({ pushSubscription: subscription ?? null })
      .where(eq(devices.id, deviceId));
  }

  async getDevicesForUser(userId: string): Promise<Device[]> {
    const rows = await this.db.select().from(devices).where(eq(devices.userId, userId));
    return rows.map((d) => ({ ...d, pushSubscription: d.pushSubscription ?? undefined }));
  }

  async createPairingCode(userId: string): Promise<PairingCode> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const [pairing] = await this.db
      .insert(pairingCodes)
      .values({ code, userId, expiresAt: this.now() + PAIRING_CODE_TTL_MS, consumed: false })
      .returning();
    return pairing;
  }

  async consumePairingCode(code: string): Promise<PairingCode | undefined> {
    const [pairing] = await this.db
      .update(pairingCodes)
      .set({ consumed: true })
      .where(and(eq(pairingCodes.code, code), eq(pairingCodes.consumed, false), gte(pairingCodes.expiresAt, this.now())))
      .returning();
    return pairing;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    await this.db.insert(sessions).values(session).onConflictDoUpdate({ target: sessions.id, set: session });
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.db.update(sessions).set({ status }).where(eq(sessions.id, sessionId));
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    return session;
  }

  /**
   * Every session the user hasn't dismissed: anything not yet stopped, plus
   * anything stopped but not yet dismissed. dismissSession only ever sets
   * `dismissed` on a stopped session, so this single filter covers both.
   */
  async getActiveSessionsForUser(userId: string): Promise<SessionRecord[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.dismissed, false)));
  }

  async dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult> {
    const [session] = await this.db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session) return 'not_found';
    if (session.userId !== userId) return 'forbidden';
    if (session.status !== 'stopped') return 'not_stopped';
    await this.db.update(sessions).set({ dismissed: true }).where(eq(sessions.id, sessionId));
    return 'ok';
  }

  async appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent> {
    const [stored] = await this.db
      .insert(sessionEvents)
      .values({ sessionId, event, createdAt: this.now() })
      .returning();
    // Keeps the session's "most recently active" marker in sync with the
    // event stream, so list-view sorting never needs to fetch that stream.
    await this.db.update(sessions).set({ lastEventAt: event.at }).where(eq(sessions.id, sessionId));
    return stored;
  }

  async getSessionEvents(sessionId: string, sinceSeq = 0): Promise<StoredSessionEvent[]> {
    return this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, sinceSeq)));
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -w @companion/relay -- postgres-store`
Expected: PASS (all 20 cases, the same ones `InMemoryStore` passes)

- [ ] **Step 8: Run the full relay suite**

Run: `npm test -w @companion/relay`
Expected: PASS across every test file in the package (this now requires the real Neon `DATABASE_URL` from `.env` to be reachable — `hub.test.ts`/`server.test.ts`/etc. still use `InMemoryStore` directly and are unaffected, but `schema.test.ts` and `postgres-store.test.ts` need the database).

- [ ] **Step 9: Commit**

```bash
git add packages/relay/src/postgres-store.ts packages/relay/src/store-contract-tests.ts packages/relay/src/in-memory-store.test.ts packages/relay/src/postgres-store.test.ts
git commit -m "feat(relay): implement PostgresStore, verified against the existing Store contract tests"
```

---

### Task 3: Wire `main.ts` to Postgres, update the README

**Files:**
- Modify: `packages/relay/src/main.ts`
- Modify: `packages/relay/README.md`

**Interfaces:**
- Consumes: `createDbClient(connectionString: string): { pool: Pool; db: Db }` and `runMigrations(db: Db): Promise<void>` from `./db/client.js` / `./db/migrate.js` (Task 1); `PostgresStore` constructor `(db: Db, now?: () => number)` from `./postgres-store.js` (Task 2).
- Produces: nothing consumed by other tasks — this is the final integration task.

- [ ] **Step 1: Replace `InMemoryStore` with `PostgresStore` in `main.ts`**

Replace the full contents of `packages/relay/src/main.ts` with:

```ts
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
```

- [ ] **Step 2: Build and smoke-test the relay against the real Postgres**

`packages/relay/.env` already exists with the real Neon `DATABASE_URL` (set up before Task 1 started).

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors.

Start the relay and confirm it boots against Postgres instead of crashing or falling back to anything in-memory:

```bash
cd packages/relay
node dist/main.js
```

Expected console output: `Companion relay listening on http://0.0.0.0:8787` (plus the "Push notifications are disabled" line, since no VAPID env vars are set locally). In a second terminal, confirm the server is actually live and backed by the real store:

```bash
curl -i http://localhost:8787/push/vapid-public-key
```

Expected: `HTTP/1.1 404 Not Found` with `{"error":"Push notifications are not configured on this relay"}` (proves the process is up and routing through `PostgresStore`-backed `createRelayServer`, not crashing on startup). Stop the relay (Ctrl+C).

Now confirm the `DATABASE_URL`-required guard actually works — temporarily move `.env` aside so nothing supplies `DATABASE_URL`, since `main.ts` otherwise auto-loads it:

```bash
mv .env .env.tmp
node dist/main.js
mv .env.tmp .env
```

Expected: the process throws `Error: DATABASE_URL is required — ...` and exits immediately, without attempting to listen on any port. Confirm the final `mv` restored `.env` before moving on — later steps and Task 3's own README/build verification need it back in place.

- [ ] **Step 3: Update the relay README**

In `packages/relay/README.md`, the `## Run` section currently reads:

```markdown
## Run

    npm run build
    npm start

Set `COMPANION_RELAY_PORT` (default `8787`) and `COMPANION_RELAY_HOST`
(default `0.0.0.0` — unlike the daemon, this server is meant to be
publicly reachable) to configure the listener.

Set `COMPANION_RELAY_VAPID_PUBLIC_KEY`, `COMPANION_RELAY_VAPID_PRIVATE_KEY`,
and `COMPANION_RELAY_VAPID_SUBJECT` (a `mailto:` URI, required by the Web
Push protocol) to enable push notifications. All three must be set together
or none take effect — with any missing, the relay runs exactly as it does
today and `GET /push/vapid-public-key` returns `404`.
```

Replace with:

```markdown
## Run

Requires a Postgres database (Neon in this project) — set `DATABASE_URL`
to a connection string before starting; the relay fails fast at startup if
it's unset. For local development, copy the example env file and fill in
a real connection string:

    cp packages/relay/.env.example packages/relay/.env

`main.ts` and the test suite (`vitest.config.ts`) both load
`packages/relay/.env` automatically at startup via Node's built-in
`process.loadEnvFile()` — no local database engine to install, and no
extra flags needed for `npm start` or `npm test`.

Then:

    npm run build
    npm start

Migrations (`packages/relay/drizzle/`) run automatically at startup before
the HTTP server starts listening — there's no separate migrate command to
run by hand. When `src/db/schema.ts` changes, generate a new migration with
`npm run db:generate -w @companion/relay` and commit the resulting files.

Set `COMPANION_RELAY_PORT` (default `8787`) and `COMPANION_RELAY_HOST`
(default `0.0.0.0` — unlike the daemon, this server is meant to be
publicly reachable) to configure the listener.

Set `COMPANION_RELAY_VAPID_PUBLIC_KEY`, `COMPANION_RELAY_VAPID_PRIVATE_KEY`,
and `COMPANION_RELAY_VAPID_SUBJECT` (a `mailto:` URI, required by the Web
Push protocol) to enable push notifications. All three must be set together
or none take effect — with any missing, the relay runs exactly as it does
today and `GET /push/vapid-public-key` returns `404`.
```

The `## Current scope (v1)` section currently starts with this bullet:

```markdown
- Storage (`Store`) and cross-instance routing (`PubSub`) are in-memory —
  state does not persist across restarts and this process cannot yet be
  horizontally scaled. Both are defined as port interfaces
  (`store.ts`, `pubsub.ts`) specifically so real Postgres/Redis-backed
  implementations can be swapped in later without touching `hub.ts`,
  `pairing.ts`, or `server.ts`.
```

Replace it with:

```markdown
- Storage (`Store`) is backed by Postgres (`PostgresStore`) and durable
  across restarts. Cross-instance routing (`PubSub`) is still in-memory,
  so this process cannot yet be horizontally scaled — both are defined as
  port interfaces (`store.ts`, `pubsub.ts`) specifically so a real
  Redis-backed `PubSub` can be swapped in later without touching `hub.ts`,
  `pairing.ts`, or `server.ts`.
```

- [ ] **Step 4: Run the full repo test suite and build**

Run: `npm test` from the repo root (`D:\Companion`)
Expected: PASS across all four packages (`packages/relay/.env`'s `DATABASE_URL` must be reachable).

Run: `npm run build` from the repo root
Expected: PASS with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/main.ts packages/relay/README.md
git commit -m "feat(relay): wire main.ts to PostgresStore, require DATABASE_URL at startup"
```
