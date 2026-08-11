import { randomInt } from 'node:crypto';
import { and, asc, eq, gt, gte, lt } from 'drizzle-orm';
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
    // Expired codes are never otherwise deleted; sweep them here so this
    // table doesn't grow forever now that storage is durable across restarts
    // (the old InMemoryStore leaked the same way, but a process restart used
    // to clear it for free — that safety net is gone).
    await this.db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, this.now()));
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
}
