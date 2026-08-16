import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, bigint, bigserial, boolean, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { PushSubscriptionPayload, SessionEvent } from '@companion/protocol';

// No FK from userId/daemonDeviceId/sessionId back to their owning tables,
// anywhere in this schema. Two independent reasons, both real:
//   1. daemonDeviceId specifically: InMemoryStore's deleteDevice()
//      intentionally leaves sessions pointing at a deleted device's id
//      (the disconnect-grace path in ConnectionHub is what marks those
//      sessions stopped, not device deletion) — a real FK would turn that
//      into a delete failure instead.
//   2. userId and sessionId generally: the store contract tests (and the
//      InMemoryStore they also run against) create devices/sessions/events
//      against arbitrary opaque id strings like 'user-1' and 'sess-1' that
//      were never inserted into `users`/`sessions` as real rows first. Both
//      Store implementations treat these ids as opaque scoping keys, never
//      as validated references, so adding real FK enforcement to only the
//      Postgres side would break that behavioral parity — the port's
//      contract, which is what both implementations must satisfy
//      identically, does not promise referential integrity. (This is a
//      deliberate limitation of the port's contract, not a consequence of
//      there being only one user: real multi-user support now exists via
//      getOrCreateUserByClerkId.) The rows that matter for isolation are
//      never orphaned in practice — a device is only ever created with the
//      userId of a user the relay just resolved from Clerk, and a session
//      only with the userId of an authenticated daemon's device.
// Indexes (not constraints) are still added on the columns actually
// queried by userId/sessionId, since those speed up real lookups without
// asserting anything about what rows exist.
//
// For the same reason, userId/daemonDeviceId columns (and devices.id) are
// `text`, not the native Postgres `uuid` type: the contract-test suite
// supplies opaque non-UUID-format strings like 'user-1' and 'device-1' for
// these fields directly, and a native `uuid` column rejects any value that
// isn't valid UUID syntax at the SQL level — a parse error, not a "no rows
// match" result — which breaks parity with InMemoryStore's plain-string
// Map keys. devices.id still gets an actual UUID value by default via
// $defaultFn, it's just stored/compared as text so lookups with arbitrary
// strings behave like a normal miss instead of throwing.

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const devices = pgTable('devices', {
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  userId: text('user_id').notNull(),
  type: text('type', { enum: ['daemon', 'browser'] }).notNull(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  pushSubscription: jsonb('push_subscription').$type<PushSubscriptionPayload>(),
}, (table) => ([
  index('devices_user_id_idx').on(table.userId),
  // Database-level backstop for the one-daemon-per-account rule. The service
  // layer already checks it twice (at claim time, and again at redemption time
  // in PairingService.pollPairingCode), but those checks are separate
  // statements from the INSERT — this partial unique index is what makes a
  // second daemon row for the same account impossible even in the residual
  // window between them. Partial, so browser devices are unconstrained: a user
  // may have as many browsers as they like.
  uniqueIndex('devices_one_daemon_per_user').on(table.userId).where(sql`${table.type} = 'daemon'`),
]));

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userId: text('user_id'),
  deviceName: text('device_name').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  redeemed: boolean('redeemed').notNull().default(false),
  // Failed-claim lockout counter (see MAX_PAIRING_CODE_ATTEMPTS in
  // store.ts): bounds repeated re-claim attempts against a code an
  // attacker has already obtained by some other means. It does NOT bound
  // blind guessing of an unknown code — see claim_failures below for that.
  // Defaulted so existing rows keep working after this column was added.
  failedAttempts: integer('failed_attempts').notNull().default(0),
});

// Persistent per-account failed-`/pairing/claim`-attempt counter (see
// CLAIM_FAILURE_LIMIT / CLAIM_FAILURE_WINDOW_MS in store.ts). This — not
// pairingCodes.failedAttempts above — is what actually bounds an online
// guessing attack long-term: a wrong guess matches no pairing_codes row at
// all (code is that table's primary key), so nothing there can count it,
// whereas this table is keyed by the guessing account and updated
// regardless of whether the guessed code exists. A separate table rather
// than columns on `users`: this is high-churn, disposable rate-limiting
// state, not account identity, and keeping it off `users` avoids UPDATE
// churn on an otherwise-static table plus the need for nullable columns on
// every user who has never failed a claim. No FK to users.id for the same
// reason the rest of this file has none (see the top-of-file comment) —
// userId here is the same opaque scoping key convention used everywhere
// else, including in the contract-test suite.
export const claimFailures = pgTable('claim_failures', {
  userId: text('user_id').primaryKey(),
  count: integer('count').notNull().default(0),
  windowStart: bigint('window_start', { mode: 'number' }).notNull(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  daemonDeviceId: text('daemon_device_id').notNull(),
  projectPath: text('project_path').notNull(),
  status: text('status', { enum: ['running', 'waiting_permission', 'waiting_input', 'paused', 'stopped'] }).notNull(),
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
