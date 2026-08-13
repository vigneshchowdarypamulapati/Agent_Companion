import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateDeviceToken, POLL_INTERVAL_MS, type FetchLike } from './device-auth.js';

describe('getOrCreateDeviceToken', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('requests a code and persists the token once the first poll reports complete', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'nested', 'device.json');
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/pairing/request-code')) {
        expect(JSON.parse(init!.body!)).toEqual({ deviceName: 'laptop' });
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      if (url.endsWith('/pairing/poll')) {
        expect(JSON.parse(init!.body!)).toEqual({ deviceCode: 'devcode-1' });
        return { ok: true, status: 200, json: async () => ({ status: 'complete', token: 'secret-token', deviceId: 'device-1' }) };
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
    expect(calls).toEqual(['http://localhost:8787/pairing/request-code', 'http://localhost:8787/pairing/poll']);

    const persisted = JSON.parse(await readFile(tokenPath, 'utf8'));
    expect(persisted).toEqual({ token: 'secret-token', deviceId: 'device-1' });
  });

  it('keeps polling while pending, then returns once claimed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    let pollCount = 0;
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith('/pairing/request-code')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      pollCount++;
      if (pollCount < 3) {
        return { ok: true, status: 200, json: async () => ({ status: 'pending' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', token: 'secret-token', deviceId: 'device-1' }) };
    };

    const promise = getOrCreateDeviceToken({
      relayHttpUrl: 'http://x',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });
    // getOrCreateDeviceToken's first step (readExisting) does a real,
    // unfaked fs.readFile before pollForToken ever registers its first
    // setTimeout. Without yielding to the real event loop first,
    // advanceTimersByTimeAsync can finish fast-forwarding the virtual clock
    // before that setTimeout exists to be advanced, and the loop then hangs
    // forever waiting on a timer that will never fire. Two real setImmediate
    // turns are enough to let the real I/O settle first.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(await promise).toEqual({ token: 'secret-token', deviceId: 'device-1' });
    expect(pollCount).toBe(3);
  });

  it('throws when the pairing code expires before being claimed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith('/pairing/request-code')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'expired' }) };
    };

    await expect(
      getOrCreateDeviceToken({ relayHttpUrl: 'http://x', deviceName: 'laptop', tokenPath, fetchFn })
    ).rejects.toThrow('Pairing code expired');
  });

  it('does not double up the slash when relayHttpUrl has a trailing slash', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/pairing/request-code')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', token: 'secret-token', deviceId: 'device-1' }) };
    };

    await getOrCreateDeviceToken({
      relayHttpUrl: 'http://x/',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });

    expect(calls).toEqual(['http://x/pairing/request-code', 'http://x/pairing/poll']);
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
