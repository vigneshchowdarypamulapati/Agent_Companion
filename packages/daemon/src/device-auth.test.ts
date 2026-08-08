import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateDeviceToken, type FetchLike } from './device-auth.js';

describe('getOrCreateDeviceToken', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('self-pairs against the relay and persists the token when no token file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'nested', 'device.json');
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/pairing/request-code')) {
        return { ok: true, status: 201, json: async () => ({ code: '123456', expiresAt: Date.now() + 60_000 }) };
      }
      if (url.endsWith('/pairing/redeem')) {
        expect(JSON.parse(init!.body!)).toEqual({ code: '123456', deviceType: 'daemon', deviceName: 'laptop' });
        return { ok: true, status: 201, json: async () => ({ token: 'secret-token', deviceId: 'device-1' }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const credentials = await getOrCreateDeviceToken({
      relayHttpUrl: 'http://localhost:8787',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });

    expect(credentials).toEqual({ token: 'secret-token', deviceId: 'device-1' });
    expect(calls).toEqual(['http://localhost:8787/pairing/request-code', 'http://localhost:8787/pairing/redeem']);

    const persisted = JSON.parse(await readFile(tokenPath, 'utf8'));
    expect(persisted).toEqual({ token: 'secret-token', deviceId: 'device-1' });
  });

  it('reuses a previously persisted token without calling the relay', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'seeded-token', deviceId: 'device-1' }));

    const fetchFn: FetchLike = async () => {
      throw new Error('fetch should not be called when a token file already exists');
    };

    const credentials = await getOrCreateDeviceToken({
      relayHttpUrl: 'http://x',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });
    expect(credentials).toEqual({ token: 'seeded-token', deviceId: 'device-1' });
  });

  it('throws when the relay rejects the pairing code request', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });

    await expect(
      getOrCreateDeviceToken({ relayHttpUrl: 'http://x', deviceName: 'laptop', tokenPath, fetchFn })
    ).rejects.toThrow('Failed to request a pairing code');
  });

  it('throws when the persisted token file is malformed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'only-token-no-device-id' }));

    await expect(
      getOrCreateDeviceToken({
        relayHttpUrl: 'http://x',
        deviceName: 'laptop',
        tokenPath,
        fetchFn: async () => {
          throw new Error('fetch should not be called');
        },
      })
    ).rejects.toThrow('malformed');
  });
});
