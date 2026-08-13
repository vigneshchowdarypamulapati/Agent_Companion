import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';

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
  pushSubscription?: PushSubscriptionPayload;
}

export interface PairingCode {
  code: string;
  deviceCode: string;
  userId: string | null;
  deviceName: string;
  expiresAt: number;
  redeemed: boolean;
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
  getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User>;
  createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device>;
  getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined>;
  deleteDevice(deviceId: string): Promise<void>;
  setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void>;
  getDevicesForUser(userId: string): Promise<Device[]>;
  getDaemonDeviceForUser(userId: string): Promise<Device | undefined>;
  createPairingCode(deviceName: string): Promise<PairingCode>;
  claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'>;
  getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined>;
  markPairingCodeRedeemed(deviceCode: string): Promise<void>;
  upsertSession(session: SessionRecord): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>;
  dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>;
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
}
