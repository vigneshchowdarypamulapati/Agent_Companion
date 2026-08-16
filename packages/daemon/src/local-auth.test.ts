import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    const seeded = generateToken();
    await writeFile(tokenPath, JSON.stringify({ token: seeded }));

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).toBe(seeded);
  });

  // Windows doesn't enforce POSIX mode bits the way POSIX systems do, so
  // this assertion is only meaningful there — same limitation the existing
  // device-token persistence (device-auth.ts) already has.
  it.skipIf(process.platform === 'win32')(
    'persists the token file with 0600 permissions (owner read/write only)',
    async () => {
      dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
      const tokenPath = join(dir, 'local-http.json');

      await getOrCreateLocalToken({ tokenPath });

      const stats = await stat(tokenPath);
      expect(stats.mode & 0o777).toBe(0o600);
    }
  );

  it('regenerates the token and warns, rather than throwing, when the file is corrupt JSON', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'local-http.json');
    await writeFile(tokenPath, '{not valid json at all');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('corrupt'));
    const persisted = JSON.parse(await readFile(tokenPath, 'utf8'));
    expect(persisted).toEqual({ token });
    warnSpy.mockRestore();
  });

  it('regenerates the token and warns, rather than throwing, when the file has the wrong shape', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'local-http.json');
    await writeFile(tokenPath, JSON.stringify({ notAToken: true }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unexpected shape'));
    warnSpy.mockRestore();
  });

  it('rejects an implausibly short token as an invalid shape and regenerates', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'local-http.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'a' }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).not.toBe('a');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    warnSpy.mockRestore();
  });

  it('rejects a non-hex token as an invalid shape and regenerates', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-local-auth-'));
    const tokenPath = join(dir, 'local-http.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'z'.repeat(64) }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await getOrCreateLocalToken({ tokenPath });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    warnSpy.mockRestore();
  });
});
