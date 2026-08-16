import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LocalAuthOptions {
  tokenPath: string;
}

/**
 * Returns the bearer token that authenticates requests to the daemon's local
 * HTTP control surface, reading it from `tokenPath` if a previous run
 * already generated one, or generating and persisting a new one otherwise.
 *
 * Mirrors the persistence pattern established in device-auth.ts (JSON file
 * on disk, 0600 on POSIX) but is a distinct secret from the relay device
 * token: this one never leaves the machine — it only authenticates local
 * loopback callers of this daemon's own HTTP surface.
 */
export async function getOrCreateLocalToken(options: LocalAuthOptions): Promise<string> {
  const existing = await readExisting(options.tokenPath);
  if (existing) return existing;

  const token = generateToken();
  await persist(options.tokenPath, token);
  return token;
}

/** 32 random bytes, hex-encoded (64 hex characters). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time token comparison for use in auth middleware.
 *
 * crypto.timingSafeEqual throws if given two buffers of different length,
 * and the presented token here is attacker-controlled input straight off
 * the wire — a length mismatch must never be able to throw inside auth
 * middleware. Hashing both sides to a fixed-length digest first sidesteps
 * that entirely: timingSafeEqual always receives two 32-byte buffers,
 * regardless of what length the caller presented.
 */
export function tokensMatch(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

interface PersistedToken {
  token: string;
}

/** Matches exactly what generateToken() produces: 32 bytes, hex-encoded. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

function hasValidTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

/**
 * Reads a previously persisted token, or undefined if there isn't a usable
 * one yet. A corrupt file (invalid JSON) or a file with content that isn't
 * shaped like a real token (wrong type, wrong length, wrong charset) is
 * treated the same as "no token yet" rather than throwing: this is a
 * locally-generated, locally-persisted secret with no external state tied
 * to it, so silently regenerating is safe and strictly better than taking
 * the whole daemon down over a damaged cache file on disk. The one thing
 * it must not do is fail *silently* — a warning is logged so the damaged
 * file doesn't go unnoticed.
 */
async function readExisting(tokenPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `Local HTTP token file at ${tokenPath} is corrupt (invalid JSON) — regenerating a new token.`
    );
    return undefined;
  }

  const token = (parsed as Partial<PersistedToken> | null)?.token;
  if (!hasValidTokenShape(token)) {
    console.warn(
      `Local HTTP token file at ${tokenPath} has an unexpected shape — regenerating a new token.`
    );
    return undefined;
  }
  return token;
}

async function persist(tokenPath: string, token: string): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify({ token } satisfies PersistedToken, null, 2), {
    mode: 0o600,
  });
}
