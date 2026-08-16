import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateLocalToken, generateToken, tokensMatch } from './local-auth.js';

describe('generateToken', () => {
  it('returns 32 random bytes, hex-encoded', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a different token on each call', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('tokensMatch', () => {
  it('returns true for identical tokens', () => {
    const token = generateToken();
    expect(tokensMatch(token, token)).toBe(true);
  });

  it('returns false for different tokens of equal length', () => {
    expect(tokensMatch('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('returns false rather than throwing when lengths differ', () => {
    expect(() => tokensMatch('short', generateToken())).not.toThrow();
    expect(tokensMatch('short', generateToken())).toBe(false);
  });

  it('returns false for an empty presented token', () => {
    expect(tokensMatch('', generateToken())).toBe(false);
  });
});

describe('getOrCreateLocalToken', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('generates and persists a token on first run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'nested', 'local-http.json');

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const persisted = JSON.parse(await readFile(tokenPath, 'utf8'));
    expect(persisted).toEqual({ token });
  });

  it('reuses a previously persisted token instead of generating a new one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'local-http.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'seeded-token' }));

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).toBe('seeded-token');
  });

  it('throws when the persisted token file is malformed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'local-http.json');
    await writeFile(tokenPath, JSON.stringify({ notAToken: true }));

    await expect(getOrCreateLocalToken({ tokenPath })).rejects.toThrow('malformed');
  });
});
