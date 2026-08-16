import { randomBytes } from 'node:crypto';
import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';

/**
 * Crockford base32: digits 0-9 plus A-Z, minus I, L, O, U. I/L/O are dropped
 * for visual ambiguity with 1 and 0; U is dropped to avoid accidental
 * profanity when a human is reading random letters aloud. 32 symbols, so
 * each character carries exactly 5 bits.
 */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 8 characters * 5 bits/char = 40 bits of entropy. */
export const PAIRING_CODE_LENGTH = 8;

/**
 * A pairing code is invalidated once this many claim attempts against it
 * have failed, regardless of whether its TTL has otherwise expired. This is
 * the persistent half of the pairing-code defense: unlike an in-memory
 * per-account rate limiter, it lives on the code's own row, so it survives
 * process restarts/redeploys and can't be dodged by attempting from a fresh
 * account.
 */
export const MAX_PAIRING_CODE_ATTEMPTS = 5;

/**
 * Draws a single index in `[0, alphabetSize)` from `randomBytes` using
 * rejection sampling, so every index is exactly uniform. A byte whose value
 * falls in the partial final bucket — anything >= the largest multiple of
 * `alphabetSize` that fits in a byte — is discarded and redrawn rather than
 * reduced with `%`, which would bias low indices whenever 256 isn't an exact
 * multiple of `alphabetSize`. For `PAIRING_CODE_ALPHABET` specifically,
 * 256 % 32 is 0, so no byte is ever actually rejected there — see
 * store.test.ts, which exercises this same function with alphabet sizes
 * that *don't* divide 256 evenly to prove the rejection check, not the
 * coincidence, is what keeps it unbiased.
 */
export function randomAlphabetIndex(alphabetSize: number): number {
  if (!Number.isInteger(alphabetSize) || alphabetSize < 1 || alphabetSize > 256) {
    throw new RangeError('alphabetSize must be an integer between 1 and 256');
  }
  const maxAcceptable = Math.floor(256 / alphabetSize) * alphabetSize;
  while (true) {
    const byte = randomBytes(1)[0];
    if (byte < maxAcceptable) return byte % alphabetSize;
  }
}

/** Draws `PAIRING_CODE_LENGTH` characters from `PAIRING_CODE_ALPHABET`, unbiased (see `randomAlphabetIndex`). */
export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_CODE_ALPHABET[randomAlphabetIndex(PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Canonicalizes a human-typed pairing code for matching: uppercased, with
 * whitespace and hyphens stripped. Lets a human type the code exactly as
 * displayed (`XXXX-XXXX`), all lowercase, with stray spaces, or as one
 * unbroken run of characters — all of these normalize to the same value a
 * pairing code is actually stored under.
 */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Groups a canonical code for display, e.g. `ABCD1234` -> `ABCD-1234`. */
export function formatPairingCodeForDisplay(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

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
  /** Number of failed claim attempts against this specific code. See `MAX_PAIRING_CODE_ATTEMPTS`. */
  failedAttempts: number;
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
  /**
   * Atomically flips `redeemed` false -> true and returns the updated row, but
   * only if the row exists, has been claimed (`userId` set), and was not
   * already redeemed. Returns `undefined` otherwise, which is how a caller
   * that lost a race to a concurrent redemption finds out — this is the single
   * point that makes a pairing code redeemable exactly once.
   */
  redeemPairingCode(deviceCode: string): Promise<PairingCode | undefined>;
  upsertSession(session: SessionRecord): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>;
  dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>;
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
  getLastEventOfType(sessionId: string, type: SessionEvent['type'], beforeSeq?: number): Promise<StoredSessionEvent | undefined>;
}
