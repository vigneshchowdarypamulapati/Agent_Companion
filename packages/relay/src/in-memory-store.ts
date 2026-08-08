import { randomInt, randomUUID } from 'node:crypto';
import type { SessionEvent, SessionStatus } from '@companion/protocol';
import type {
  Device,
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
   * The most recently started non-stopped session for the user. Recency, not
   * Map insertion order, is what decides: a daemon that dies without emitting
   * a `stopped` event leaves its session non-stopped forever, and returning
   * that corpse ahead of a genuinely live session would point the browser at
   * the wrong one. (Reaping such sessions is a separate concern.)
   */
  async getActiveSessionForUser(userId: string): Promise<SessionRecord | undefined> {
    let latest: SessionRecord | undefined;
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.status === 'stopped') continue;
      if (!latest || session.startedAt > latest.startedAt) {
        latest = session;
      }
    }
    return latest;
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
    return stored;
  }

  async getSessionEvents(sessionId: string, sinceSeq = 0): Promise<StoredSessionEvent[]> {
    const list = this.events.get(sessionId) ?? [];
    return list.filter((e) => e.seq > sinceSeq);
  }
}
