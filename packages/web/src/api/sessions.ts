import type { SessionEvent, SessionStatus } from '@companion/protocol';
import { RELAY_HTTP_URL } from '../config';

export interface SessionRecord {
  id: string;
  userId: string;
  daemonDeviceId: string;
  projectPath: string;
  status: SessionStatus;
  startedAt: number;
  lastEventAt: number;
}

export interface StoredSessionEvent {
  seq: number;
  sessionId: string;
  event: SessionEvent;
  createdAt: number;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Relay rejected the stored device token');
    this.name = 'UnauthorizedError';
  }
}

export async function getActiveSessions(token: string): Promise<SessionRecord[]> {
  const res = await fetch(`${RELAY_HTTP_URL}/sessions/active`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch active sessions: HTTP ${res.status}`);
  }
  return (await res.json()) as SessionRecord[];
}

export async function dismissSession(token: string, sessionId: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/sessions/${encodeURIComponent(sessionId)}/dismiss`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 409) {
    throw new Error('Session is not stopped yet');
  }
  if (!res.ok) {
    throw new Error(`Failed to dismiss session: HTTP ${res.status}`);
  }
}

export async function getSessionEvents(
  token: string,
  sessionId: string,
  sinceSeq?: number
): Promise<StoredSessionEvent[]> {
  const url = new URL(`${RELAY_HTTP_URL}/sessions/${encodeURIComponent(sessionId)}/events`);
  if (sinceSeq !== undefined) {
    url.searchParams.set('since', String(sinceSeq));
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch session events: HTTP ${res.status}`);
  }
  return (await res.json()) as StoredSessionEvent[];
}
