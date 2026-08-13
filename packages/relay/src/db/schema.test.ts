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
      .values({ clerkUserId: `clerk-schema-test-${Date.now()}`, email: `schema-test-${Date.now()}@example.com`, createdAt: 1 })
      .returning();
    expect(user.id).toBeDefined();

    const [device] = await db
      .insert(devices)
      .values({ userId: user.id, type: 'browser', name: 'test-device', tokenHash: `hash-${Date.now()}`, createdAt: 1 })
      .returning();
    expect(device.id).toBeDefined();

    const [pairing] = await db
      .insert(pairingCodes)
      .values({
        code: `${Date.now()}`.slice(-6),
        deviceCode: `device-code-${Date.now()}`,
        userId: user.id,
        deviceName: 'test-device',
        expiresAt: 1,
        redeemed: false,
      })
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
