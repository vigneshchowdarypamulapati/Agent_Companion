import { randomUUID } from 'node:crypto';
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
  email: text('email').notNull().unique(),
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
]));

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  consumed: boolean('consumed').notNull().default(false),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  daemonDeviceId: text('daemon_device_id').notNull(),
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
