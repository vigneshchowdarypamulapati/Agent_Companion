import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';
import {
  CLAIM_FAILURE_LIMIT,
  CLAIM_FAILURE_WINDOW_MS,
  generatePairingCode,
  MAX_PAIRING_CODE_ATTEMPTS,
  type Device,
  type DismissSessionResult,
  type PairingCode,
  type SessionRecord,
  type Store,
  type StoredSessionEvent,
  type User,
} from './store.js';
import type { Db } from './db/client.js';
import { users, devices, pairingCodes, claimFailures, sessions, sessionEvents } from './db/schema.js';

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export class PostgresStore implements Store {
  constructor(
    private db: Db,
    private now: () => number = Date.now
  ) {}

  async getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values({ clerkUserId, email, createdAt: this.now() })
      .onConflictDoUpdate({ target: users.clerkUserId, set: { email } })
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

  async getDaemonDeviceForUser(userId: string): Promise<Device | undefined> {
    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.type, 'daemon')));
    if (!device) return undefined;
    return { ...device, pushSubscription: device.pushSubscription ?? undefined };
  }

  async createPairingCode(deviceName: string): Promise<PairingCode> {
    // Expired codes are never otherwise deleted; sweep them here so this
    // table doesn't grow forever now that storage is durable across restarts.
    await this.db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, this.now()));
    const code = generatePairingCode();
    const deviceCode = randomUUID();
    const [pairing] = await this.db
      .insert(pairingCodes)
      .values({
        code,
        deviceCode,
        userId: null,
        deviceName,
        expiresAt: this.now() + PAIRING_CODE_TTL_MS,
        redeemed: false,
        failedAttempts: 0,
      })
      .returning();
    return pairing;
  }

  /**
   * A single conditional UPDATE is the atomic success path — it only
   * matches (and claims) a row that is unexpired, not yet claimed, and
   * hasn't already hit the failed-attempt cap. The SELECT below only runs to
   * classify *why* it didn't match, for a precise result; it never decides
   * the outcome itself.
   *
   * A code that has racked up `MAX_PAIRING_CODE_ATTEMPTS` failed claims is
   * reported exactly like an expired one — no separate status leaks that a
   * lockout (rather than ordinary TTL expiry) is what happened, preserving
   * the existing not_found/expired/already_claimed non-enumeration
   * property. The only way to fail against a row that still exists,
   * is unexpired, and is under the cap is for it to already be claimed by
   * someone — an unclaimed, unexpired, under-cap code always matches the
   * UPDATE above. Of that, only a claim by someone *other* than the current
   * owner counts toward the cap: a re-claim by the same account that
   * already owns the code is the ordinary retry/double-tap in the ~2s
   * window before the daemon's poll redeems it, not a guess, and counting
   * it would let a legitimate user brick their own pairing.
   */
  async claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'> {
    const [claimed] = await this.db
      .update(pairingCodes)
      .set({ userId })
      .where(
        and(
          eq(pairingCodes.code, code),
          isNull(pairingCodes.userId),
          gte(pairingCodes.expiresAt, this.now()),
          lt(pairingCodes.failedAttempts, MAX_PAIRING_CODE_ATTEMPTS)
        )
      )
      .returning();
    if (claimed) return 'ok';

    const [pairing] = await this.db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    if (!pairing) return 'not_found';
    if (pairing.failedAttempts >= MAX_PAIRING_CODE_ATTEMPTS) return 'expired';
    if (pairing.expiresAt < this.now()) return 'expired';
    if (pairing.userId === userId) return 'already_claimed';

    const [updated] = await this.db
      .update(pairingCodes)
      .set({ failedAttempts: sql`${pairingCodes.failedAttempts} + 1` })
      .where(eq(pairingCodes.code, code))
      .returning();
    if (updated && updated.failedAttempts >= MAX_PAIRING_CODE_ATTEMPTS) return 'expired';
    return 'already_claimed';
  }

  async getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined> {
    const [pairing] = await this.db.select().from(pairingCodes).where(eq(pairingCodes.deviceCode, deviceCode));
    return pairing;
  }

  /**
   * A single conditional UPDATE, like claimPairingCode above: the WHERE clause
   * is the whole guard, so two concurrent redemptions of the same device code
   * can never both match — exactly one gets a row back, the other gets none.
   */
  async redeemPairingCode(deviceCode: string): Promise<PairingCode | undefined> {
    const [redeemed] = await this.db
      .update(pairingCodes)
      .set({ redeemed: true })
      .where(
        and(
          eq(pairingCodes.deviceCode, deviceCode),
          isNotNull(pairingCodes.userId),
          eq(pairingCodes.redeemed, false)
        )
      )
      .returning();
    return redeemed;
  }

  async isClaimRateLimited(userId: string): Promise<boolean> {
    const [row] = await this.db.select().from(claimFailures).where(eq(claimFailures.userId, userId));
    if (!row) return false;
    if (this.now() - row.windowStart > CLAIM_FAILURE_WINDOW_MS) return false;
    return row.count >= CLAIM_FAILURE_LIMIT;
  }

  /**
   * Read-then-write, matching InMemoryStore's algorithm exactly: if no
   * window is open yet, or the open one is stale, upsert a fresh one at
   * count 1; otherwise increment in place. This isn't wrapped in a
   * transaction/row lock, so two failed claims for the same account
   * arriving in the same instant could race and one increment could be
   * lost — an accepted trade-off for a rate limiter (not a security
   * invariant like pairing-code claiming): the only possible effect is
   * this limiter trips very slightly later than the nominal cap under
   * heavy concurrent abuse from one account, never that it locks out an
   * unrelated account or fails to eventually trip at all.
   */
  async recordFailedClaim(userId: string): Promise<void> {
    const now = this.now();
    const [row] = await this.db.select().from(claimFailures).where(eq(claimFailures.userId, userId));
    if (!row || now - row.windowStart > CLAIM_FAILURE_WINDOW_MS) {
      await this.db
        .insert(claimFailures)
        .values({ userId, count: 1, windowStart: now })
        .onConflictDoUpdate({ target: claimFailures.userId, set: { count: 1, windowStart: now } });
      return;
    }
    await this.db.update(claimFailures).set({ count: row.count + 1 }).where(eq(claimFailures.userId, userId));
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
    return this.db.transaction(async (tx) => {
      const [stored] = await tx
        .insert(sessionEvents)
        .values({ sessionId, event, createdAt: this.now() })
        .returning();
      // Keeps the session's "most recently active" marker in sync with the
      // event stream, so list-view sorting never needs to fetch that stream.
      // Both writes commit or roll back together, so a crash between them
      // can't leave a stored event whose owning session's lastEventAt never
      // advances.
      await tx.update(sessions).set({ lastEventAt: event.at }).where(eq(sessions.id, sessionId));
      return stored;
    });
  }

  async getSessionEvents(sessionId: string, sinceSeq = 0): Promise<StoredSessionEvent[]> {
    if (Number.isNaN(sinceSeq)) return [];
    return this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), gt(sessionEvents.seq, sinceSeq)))
      .orderBy(asc(sessionEvents.seq));
  }

  async getLastEventOfType(sessionId: string, type: SessionEvent['type'], beforeSeq?: number): Promise<StoredSessionEvent | undefined> {
    const [row] = await this.db
      .select()
      .from(sessionEvents)
      .where(
        and(
          eq(sessionEvents.sessionId, sessionId),
          sql`${sessionEvents.event}->>'type' = ${type}`,
          beforeSeq === undefined ? undefined : lt(sessionEvents.seq, beforeSeq)
        )
      )
      .orderBy(desc(sessionEvents.seq))
      .limit(1);
    return row;
  }
}
