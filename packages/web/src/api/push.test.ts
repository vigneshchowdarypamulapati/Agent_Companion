import { describe, it, expect, afterEach, vi } from 'vitest';
import { getVapidPublicKey, savePushSubscription, deletePushSubscription } from './push';
import { UnauthorizedError } from './sessions';

describe('push API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getVapidPublicKey returns the key on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ publicKey: 'abc' }) })));
    expect(await getVapidPublicKey()).toBe('abc');
  });

  it('getVapidPublicKey returns undefined on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await getVapidPublicKey()).toBeUndefined();
  });

  it('getVapidPublicKey throws on a non-404 error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(getVapidPublicKey()).rejects.toThrow('HTTP 500');
  });

  it('savePushSubscription resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(
      savePushSubscription('tok-1', { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } })
    ).resolves.toBeUndefined();
  });

  it('savePushSubscription sends the subscription as the request body', async () => {
    const subscription = { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual(subscription);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await savePushSubscription('tok-1', subscription);
  });

  it('savePushSubscription throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(
      savePushSubscription('bad-token', { endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('deletePushSubscription resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(deletePushSubscription('tok-1')).resolves.toBeUndefined();
  });

  it('deletePushSubscription throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(deletePushSubscription('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
