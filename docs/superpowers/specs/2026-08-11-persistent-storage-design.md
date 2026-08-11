# Persistent Storage (Postgres) — Design

## Problem

`packages/relay/src/in-memory-store.ts` is the only implementation of the
`Store` port (`store.ts`). It holds every paired device, session, session
event, pairing code, and the single seeded user in process memory. Any
relay restart — a crash, a redeploy, a host reboot — wipes all of it: every
device has to re-pair, every session's history is gone. This is fine for
local development but not for a relay anyone actually depends on.

This plan replaces `InMemoryStore` with a `PostgresStore` that implements
the exact same `Store` interface, backed by a real, durable Postgres
database, with zero change to the relay's HTTP/WebSocket contract.

## Non-Goals

- No new user-facing behavior. There is still exactly one seeded user
  (`getOrCreateDefaultUser()` keeps its current meaning) — multi-user
  accounts are a separate, later plan.
- No change to `hub.ts`, `pairing.ts`, or `server.ts` beyond how they're
  constructed in `main.ts` — they depend only on the `Store` interface,
  which does not change.
- No change to the daemon, protocol, or web packages.
- Not horizontally scaling the relay itself in this plan — that still needs
  the `PubSub` port to grow a real (e.g. Redis) implementation, which is
  out of scope here. This plan only makes storage durable.

## Architecture

**Provider: Neon.** Serverless Postgres with autosuspend-on-idle and
automatic resume on the next incoming connection (sub-second to low-second
cold start) — no manual restart step, unlike providers that pause and stay
paused until a human intervenes in a dashboard. That fits how Companion is
actually used: idle for long stretches, then needs to just work the moment
the app is opened.

**Driver: `pg` (node-postgres), not Neon's HTTP/serverless driver.** The
relay is a long-lived process holding open WebSocket connections, not a
one-shot serverless function — a real pooled TCP connection is the right
fit. Neon's own HTTP driver exists for edge/serverless call sites and isn't
a better fit here.

**ORM: Drizzle ORM + Drizzle Kit.** TypeScript-native, lightweight, generates
plain SQL migrations that get checked into the repo and applied explicitly
at startup — no hidden migration magic, no heavier ORM runtime than needed.

**Connection pooling:** the relay connects through Neon's pooled connection
string (PgBouncer, transaction mode), via a small `pg.Pool` (max 10
connections) wrapping a single Drizzle instance constructed once in
`main.ts` and threaded into `PostgresStore`.

### Schema

One table per `Store` record type, in `packages/relay/src/db/schema.ts`:

```ts
import {
  pgTable, uuid, text, bigint, bigserial, boolean, jsonb, index,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

// No FK from userId/daemonDeviceId/sessionId back to their owning tables,
// anywhere in this schema — not just on daemonDeviceId. Two independent
// reasons, both real:
//   1. daemonDeviceId specifically: InMemoryStore's deleteDevice()
//      intentionally leaves sessions pointing at a deleted device's id
//      (the disconnect-grace path in ConnectionHub is what marks those
//      sessions stopped, not device deletion) — a real FK would turn that
//      into a delete failure instead.
//   2. userId and sessionId generally: the Store interface only supports
//      one seeded user in this phase (getOrCreateDefaultUser() is a
//      singleton, there is no way to create a second real user yet), and
//      the existing contract-test suite exercises devices/sessions/events
//      created with arbitrary opaque id strings that were never inserted
//      as real rows (e.g. getDevicesForUser's own test creates devices
//      under 'user-1'/'user-2' directly). InMemoryStore never validated
//      these references either, so real FK enforcement now would silently
//      break behavioral parity with the exact test suite this plan is
//      required to keep passing unchanged. Real per-user referential
//      integrity is a multi-user-phase concern, once a real
//      user-creation API exists to make it meaningful.
// Indexes (not constraints) are still added on the columns actually
// queried by userId, since those speed up real lookups without asserting
// anything about what rows exist.
export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull(),
  type: text('type', { enum: ['daemon', 'browser'] }).notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  pushSubscription: jsonb('push_subscription'),
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
  event: jsonb('event').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ([
  index('session_events_session_id_idx').on(table.sessionId),
]));
```

All `createdAt`/`expiresAt`/`startedAt`/`lastEventAt` columns are `bigint`
storing epoch-milliseconds (Drizzle's `{ mode: 'number' }` returns them as
plain JS numbers, not strings or `Date`s) — this keeps every `Store` method
signature byte-for-byte identical to what `InMemoryStore` already returns,
since the existing code already treats these fields as raw numbers
(`Date.now()`, `pairing.expiresAt < this.now()`), not `Date` objects.

`getOrCreateDefaultUser()` becomes a single race-safe upsert instead of an
in-process `Map` check (relevant once more than one relay instance can
reach the same database), keeping the exact same seeded email
`InMemoryStore` already hardcodes today:

```ts
const DEFAULT_USER_EMAIL = 'you@example.com';

const [user] = await db
  .insert(users)
  .values({ email: DEFAULT_USER_EMAIL, createdAt: now() })
  .onConflictDoUpdate({ target: users.email, set: { email: DEFAULT_USER_EMAIL } })
  .returning();
```

Every other `Store` method maps to a straightforward Drizzle query —
`dismissSession`'s three-way `not_found` / `forbidden` / `not_stopped`
result and `deleteDevice`'s deliberate non-touching of sessions both carry
over unchanged, just expressed as SQL instead of `Map` lookups.

## Local Dev & CI

Real Postgres everywhere — no `InMemoryStore` fallback in the running
relay process, in any environment. Rather than a local Docker Postgres,
`DATABASE_URL` points directly at a real Neon project for local dev and
`npm test` too — the same provider as production, just one project used
for everything at this stage. `DATABASE_URL` is the one env var in every
environment; no code branches on it, only the connection string changes.
`main.ts` throws a clear startup error and exits if `DATABASE_URL` is
unset, rather than silently falling back to anything ephemeral.

One consequence worth being explicit about: `PostgresStore`'s own tests
truncate every table before each test case (see Testing Strategy below),
so running `npm test` against the same Neon database used for real local
development wipes whatever paired devices/sessions were sitting in it.
Accepted for now, since this is a single-developer project — Neon's
branching (free, instant, copy-on-write) can split dev and test into
separate databases later if that ever becomes disruptive, but setting that
up now would be solving a problem that doesn't exist yet.

**Scope boundary — what gets tested against real Postgres, and what
doesn't:** `PostgresStore`'s own correctness is verified against the real
Neon database — this is the whole point of "test what we ship," and is
where a real bug (constraint violation, type mismatch, query logic error)
would actually show up. `InMemoryStore` is not deleted: it stays in the
codebase and keeps backing the rest of the relay's existing test suite
(`hub.test.ts`, `server.test.ts`, `pairing`-related tests) as a fast,
dependency-free test double for tests that exercise WebSocket routing and
HTTP route behavior, not storage behavior — those tests are
storage-implementation-agnostic by design (that's what the `Store` port is
for), and switching them to real Postgres would add real network latency
to dozens of tests that aren't testing storage at all, for no correctness
benefit. This mirrors the already-approved non-goal that
`hub.ts`/`pairing.ts`/`server.ts` don't change in this plan.

Migrations are plain SQL files generated by `drizzle-kit generate` and
checked into `packages/relay/drizzle/`, applied by Drizzle's own
`migrate()` helper — once at relay startup in `main.ts` (before
`httpServer.listen(...)`), and once in a `beforeAll` in the new
`postgres-store.test.ts` before its Neon-backed connection runs any
contract-test case.

## Testing Strategy

`in-memory-store.test.ts`'s existing test bodies are extracted into a
single exported function, `runStoreContractTests(makeStore: () => Store)`,
so the exact same behavioral assertions run against both implementations:
`InMemoryStore` (fast, no setup) and `PostgresStore` (against the real
Neon database, migrated fresh — each test run truncates all tables between
tests rather than reusing state across cases). This proves behavioral
parity, not just "it compiles and the types line up."

## Migration/Rollout

This is a from-scratch deployment (the relay has never been deployed with
real users yet), so there's no production data to migrate — "rollout" here
just means: provision a Neon project, set `DATABASE_URL` in the deployed
environment, run migrations once before the first `main.ts` start.

## Global Constraints

- `PostgresStore` implements `Store` (`packages/relay/src/store.ts`)
  exactly — no interface changes.
- No change to any relay HTTP/WebSocket contract, request/response shape,
  or status code.
- `createdAt`/`expiresAt`/`startedAt`/`lastEventAt` are plain JS numbers
  (epoch-ms) at every `Store` method boundary, not `Date` objects or
  strings — this must hold at both the schema layer (`{ mode: 'number' }`)
  and every query result.
- No FK constraints on `devices.userId`, `pairingCodes.userId`,
  `sessions.userId`, `sessions.daemonDeviceId`, or `sessionEvents.sessionId`
  — none of these may reject an insert/delete because a referenced row
  doesn't exist; `users.email` and `devices.tokenHash` stay UNIQUE (real
  invariants the application logic actually relies on).
- The full existing `in-memory-store.test.ts` test suite (all 20 cases,
  unmodified) must pass verbatim against `PostgresStore` via the shared
  contract-test function — if any case needs a code change to pass, that's
  a signal the implementation deviated from `InMemoryStore`'s behavior,
  not that the test was wrong.
- `DATABASE_URL` is required in every environment the relay actually runs
  in (`main.ts` fails fast if unset); `InMemoryStore` is kept only as a
  test double for non-storage tests, never as a runtime fallback.
