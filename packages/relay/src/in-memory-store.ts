import { randomInt, randomUUID } from 'node:crypto';
import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';
import type {
  Device,
  DismissSessionResult,
  PairingCode,
  SessionRecord,
  Store,
  StoredSessionEvent,
  User,
} from './store.js';

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export class InMemoryStore implements Store {
  private users = new Map<string, User>();
  private defaultUserId: string | undefined;
  private devices = new Map<string, Device>();
  private devicesByTokenHash = new Map<string, string>();
  private pairingCodes = new Map<string, PairingCode>();
  private sessions = new Map<string, SessionRecord>();
  private events = new Map<string, StoredSessionEvent[]>();
  private nextSeq = 1;

  constructor(private now: () => number = Date.now) {}

  async getOrCreateDefaultUser(): Promise<User> {
    if (this.defaultUserId) {
      return this.users.get(this.defaultUserId)!;
    }
    const user: User = { id: randomUUID(), email: 'you@example.com', createdAt: this.now() };
    this.users.set(user.id, user);
    this.defaultUserId = user.id;
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

  async createPairingCode(userId: string): Promise<PairingCode> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const pairing: PairingCode = {
      code,
      userId,
      expiresAt: this.now() + PAIRING_CODE_TTL_MS,
      consumed: false,
    };
    this.pairingCodes.set(code, pairing);
    return pairing;
  }

  async consumePairingCode(code: string): Promise<PairingCode | undefined> {
    const pairing = this.pairingCodes.get(code);
    if (!pairing || pairing.consumed || pairing.expiresAt < this.now()) {
      return undefined;
    }
    pairing.consumed = true;
    return pairing;
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
}
