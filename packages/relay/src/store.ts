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
 * *by an account other than its current owner* have failed, regardless of
 * whether its TTL has otherwise expired. This bounds repeated re-claim
 * attempts against a code an attacker has already obtained by some other
 * means (e.g. won a claim race, or read it over someone's shoulder) — it
 * does NOT bound blind guessing of an unknown code: a wrong guess almost
 * always matches no row at all (`code` is the primary key), so there is no
 * row here to attribute the failure to. `CLAIM_FAILURE_LIMIT` /
 * `CLAIM_FAILURE_WINDOW_MS` below, keyed by the *guessing account* rather
 * than by code, are what actually bound blind guessing.
 */
export const MAX_PAIRING_CODE_ATTEMPTS = 5;

/**
 * Persistent, per-account cap on failed `/pairing/claim` attempts — this is
 * what actually bounds an online guessing attack long-term, unlike the
 * in-memory `RateLimiter` in server.ts (`claimLimiter`), which resets on
 * every process restart/redeploy and is trivially dodged by an attacker
 * simply waiting one out or, if they can trigger enough claim volume before
 * that, is the only thing standing between them and the 40-bit code space.
 * Only `not_found`/`expired` results count (see `recordFailedClaim` in each
 * Store implementation) — those are the outcomes a blind guess actually
 * produces. `already_claimed` and `daemon_exists` are excluded: they carry
 * no guessing signal (a same-account double-tap on a code it already owns
 * is expected traffic, not an attack — see the `userId === pairing.userId`
 * carve-out in `claimPairingCode` for the identical reasoning applied to
 * `MAX_PAIRING_CODE_ATTEMPTS`).
 *
 * 10 failures / 15 minutes: generous enough that a human mistyping an
 * 8-character code a few times in a row never gets locked out (5-minute
 * code TTL means they'd need to fail, get a fresh code, and fail again
 * repeatedly to even approach it), while still keeping automated guessing
 * to a low, auditable rate that's completely irrelevant against a 2^40
 * keyspace regardless — the entropy is the actual defense against success:
 * this just guarantees a hard, durable ceiling exists at all, closing the
 * "reset on every deploy" gap in the in-memory limiter.
 */
export const CLAIM_FAILURE_LIMIT = 10;
export const CLAIM_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Draws a single index in `[0, alphabetSize)` from a byte source using
 * rejection sampling, so every index is exactly uniform. A byte whose value
 * falls in the partial final bucket — anything >= the largest multiple of
 * `alphabetSize` that fits in a byte — is discarded and redrawn rather than
 * reduced with `%`, which would bias low indices whenever 256 isn't an exact
 * multiple of `alphabetSize`. For `PAIRING_CODE_ALPHABET` specifically,
 * 256 % 32 is 0, so no byte is ever actually rejected there — see
 * store.test.ts, which exercises this same function at alphabet sizes that
 * *don't* divide 256 evenly, with a deterministic (not random) byte source,
 * to prove the rejection check itself — not the 32-divides-256 coincidence
 * — is what keeps it unbiased.
 *
 * `randomByte` defaults to a real CSPRNG byte and only exists as a
 * parameter so tests can inject an exact, deterministic byte sequence
 * (including values that land in the rejected range) instead of relying on
 * statistical sampling of the real RNG, which is inherently probabilistic
 * and therefore an unavoidably flaky way to test this.
 */
export function randomAlphabetIndex(alphabetSize: number, randomByte: () => number = () => randomBytes(1)[0]): number {
  if (!Number.isInteger(alphabetSize) || alphabetSize < 1 || alphabetSize > 256) {
    throw new RangeError('alphabetSize must be an integer between 1 and 256');
  }
  const maxAcceptable = Math.floor(256 / alphabetSize) * alphabetSize;
  while (true) {
    const byte = randomByte();
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
  /**
   * Read-only: true if `userId` has hit `CLAIM_FAILURE_LIMIT` failed claims
   * within the current `CLAIM_FAILURE_WINDOW_MS` window. Does not record
   * anything itself — callers check this *before* attempting a claim, so a
   * rate-limited account's response never depends on whether the code it
   * submitted exists (preserving the not_found/expired/already_claimed
   * non-enumeration property).
   */
  isClaimRateLimited(userId: string): Promise<boolean>;
  /**
   * Records one failed claim attempt for `userId`, using a fixed window: if
   * no window is open yet, or the open one is older than
   * `CLAIM_FAILURE_WINDOW_MS`, this starts a fresh window at count 1;
   * otherwise it increments the count in the current window. A fixed
   * (rather than sliding) window can allow up to ~2x the nominal rate right
   * at a window boundary — an accepted, standard trade-off for the
   * simplicity of not tracking individual timestamps.
   */
  recordFailedClaim(userId: string): Promise<void>;
  upsertSession(session: SessionRecord): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>;
  dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>;
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
  getLastEventOfType(sessionId: string, type: SessionEvent['type'], beforeSeq?: number): Promise<StoredSessionEvent | undefined>;
}
