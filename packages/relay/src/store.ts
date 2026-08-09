import type { SessionEvent, SessionStatus } from '@companion/protocol';

export interface User {
  id: string;
  email: string;
  createdAt: number;
}

export interface Device {
  id: string;
  userId: string;
  type: 'daemon' | 'browser';
  name: string;
  tokenHash: string;
  createdAt: number;
}

export interface PairingCode {
  code: string;
  userId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  daemonDeviceId: string;
  projectPath: string;
  status: SessionStatus;
  startedAt: number;
  lastEventAt: number;
  dismissed: boolean;
}

export interface StoredSessionEvent {
  seq: number;
  sessionId: string;
  event: SessionEvent;
  createdAt: number;
}

export type DismissSessionResult = 'ok' | 'not_found' | 'forbidden' | 'not_stopped';

export interface Store {
  getOrCreateDefaultUser(): Promise<User>;
  createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device>;
  getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined>;
  createPairingCode(userId: string): Promise<PairingCode>;
  consumePairingCode(code: string): Promise<PairingCode | undefined>;
  upsertSession(session: SessionRecord): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>;
  dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>;
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
}
