import { randomUUID } from 'node:crypto';
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

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export class InMemoryStore implements Store {
  private users = new Map<string, User>();
  private usersByClerkId = new Map<string, string>();
  private devices = new Map<string, Device>();
  private devicesByTokenHash = new Map<string, string>();
  private pairingCodes = new Map<string, PairingCode>();
  private pairingCodesByDeviceCode = new Map<string, string>();
  private claimFailures = new Map<string, { count: number; windowStart: number }>();
  private sessions = new Map<string, SessionRecord>();
  private events = new Map<string, StoredSessionEvent[]>();
  private nextSeq = 1;

  constructor(private now: () => number = Date.now) {}

  async getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User> {
    const existingId = this.usersByClerkId.get(clerkUserId);
    if (existingId) return this.users.get(existingId)!;
    const user: User = { id: randomUUID(), email, createdAt: this.now() };
    this.users.set(user.id, user);
    this.usersByClerkId.set(clerkUserId, user.id);
    return user;
  }

  async createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device> {
    const device: Device = { id: randomUUID(), createdAt: this.now(), ...input };
    this.devices.set(device.id, device);
    this.devicesByTokenHash.set(device.tokenHash, device.id);
    return device;
  }

  async getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined> {
    const id = this.devicesByTokenHash.get(tokenHash);
    return id ? this.devices.get(id) : undefined;
  }

  /**
   * Removes only the device and its token index. Sessions referencing this device's id as
   * daemonDeviceId are left as-is on purpose — if it was a daemon, ConnectionHub's
   * disconnect-grace path is what marks its sessions stopped, not this method.
   */
  async deleteDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.devices.delete(deviceId);
    this.devicesByTokenHash.delete(device.tokenHash);
  }

  async setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.pushSubscription = subscription;
  }

  async getDevicesForUser(userId: string): Promise<Device[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }

  async getDaemonDeviceForUser(userId: string): Promise<Device | undefined> {
    return [...this.devices.values()].find((d) => d.userId === userId && d.type === 'daemon');
  }

  async createPairingCode(deviceName: string): Promise<PairingCode> {
    const code = generatePairingCode();
    const deviceCode = randomUUID();
    const pairing: PairingCode = {
      code,
      deviceCode,
      userId: null,
      deviceName,
      expiresAt: this.now() + PAIRING_CODE_TTL_MS,
      redeemed: false,
      failedAttempts: 0,
    };
    this.pairingCodes.set(code, pairing);
    this.pairingCodesByDeviceCode.set(deviceCode, code);
    return pairing;
  }

  /**
   * A code that has racked up `MAX_PAIRING_CODE_ATTEMPTS` failed claims is
   * treated exactly like an expired one — same external result, so nothing
   * distinguishes "expired" from "locked out by too many failed claims" for
   * a caller. A code that's already been claimed by someone *else* is the
   * only way to fail against a still-live row (an unclaimed, unexpired,
   * under-cap code always succeeds here), and that's what counts toward the
   * cap. A re-claim by the *same* account that already owns the code does
   * NOT increment: that's the ordinary retry/double-tap in the ~2s window
   * before the daemon's poll redeems it, not a guess, and penalizing it
   * would let a legitimate user brick their own pairing.
   */
  async claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'> {
    const pairing = this.pairingCodes.get(code);
    if (!pairing) return 'not_found';
    if (pairing.failedAttempts >= MAX_PAIRING_CODE_ATTEMPTS) return 'expired';
    if (pairing.expiresAt < this.now()) return 'expired';
    if (pairing.userId) {
      if (pairing.userId !== userId) {
        pairing.failedAttempts += 1;
        if (pairing.failedAttempts >= MAX_PAIRING_CODE_ATTEMPTS) return 'expired';
      }
      return 'already_claimed';
    }
    pairing.userId = userId;
    return 'ok';
  }

  async getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined> {
    const code = this.pairingCodesByDeviceCode.get(deviceCode);
    return code ? this.pairingCodes.get(code) : undefined;
  }

  /**
   * Check-and-set in one synchronous step (no `await` between the read and the
   * write), which is the in-memory equivalent of PostgresStore's single
   * conditional UPDATE: two concurrent callers can never both see
   * `redeemed === false`.
   */
  async redeemPairingCode(deviceCode: string): Promise<PairingCode | undefined> {
    const code = this.pairingCodesByDeviceCode.get(deviceCode);
    if (!code) return undefined;
    const pairing = this.pairingCodes.get(code);
    if (!pairing || !pairing.userId || pairing.redeemed) return undefined;
    pairing.redeemed = true;
    return { ...pairing };
  }

  async isClaimRateLimited(userId: string): Promise<boolean> {
    const state = this.claimFailures.get(userId);
    if (!state) return false;
    if (this.now() - state.windowStart > CLAIM_FAILURE_WINDOW_MS) return false;
    return state.count >= CLAIM_FAILURE_LIMIT;
  }

  async recordFailedClaim(userId: string): Promise<void> {
    const state = this.claimFailures.get(userId);
    if (!state || this.now() - state.windowStart > CLAIM_FAILURE_WINDOW_MS) {
      this.claimFailures.set(userId, { count: 1, windowStart: this.now() });
      return;
    }
    state.count += 1;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
    }
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(sessionId);
  }

  /**
   * Every session the user hasn't dismissed: anything not yet stopped, plus
   * anything stopped but not yet dismissed. dismissSession only ever sets
   * `dismissed` on a stopped session, so this single check covers both.
   */
  async getActiveSessionsForUser(userId: string): Promise<SessionRecord[]> {
    const result: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.dismissed) continue;
      result.push(session);
    }
    return result;
  }

  async dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return 'not_found';
    if (session.userId !== userId) return 'forbidden';
    if (session.status !== 'stopped') return 'not_stopped';
    session.dismissed = true;
    return 'ok';
  }

  async appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent> {
    const stored: StoredSessionEvent = {
      seq: this.nextSeq++,
      sessionId,
      event,
      createdAt: this.now(),
    };
    const list = this.events.get(sessionId) ?? [];
    list.push(stored);
    this.events.set(sessionId, list);
    // Keeps the session's "most recently active" marker in sync with the
    // event stream, so list-view sorting never needs to fetch that stream.
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastEventAt = event.at;
    }
    return stored;
  }

  async getSessionEvents(sessionId: string, sinceSeq = 0): Promise<StoredSessionEvent[]> {
    const list = this.events.get(sessionId) ?? [];
    return list.filter((e) => e.seq > sinceSeq);
  }

  async getLastEventOfType(sessionId: string, type: SessionEvent['type'], beforeSeq?: number): Promise<StoredSessionEvent | undefined> {
    const list = this.events.get(sessionId) ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].event.type === type && (beforeSeq === undefined || list[i].seq < beforeSeq)) return list[i];
    }
    return undefined;
  }
}
