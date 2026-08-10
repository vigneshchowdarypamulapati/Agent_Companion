import { describe, it, expect, afterEach, vi } from 'vitest';
import { getDevice, unpairDevice } from './devices';
import { UnauthorizedError } from './sessions';

describe('devices API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getDevice returns the device info on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'dev-1', type: 'browser', name: 'phone', createdAt: 123 }),
      }))
    );
    const result = await getDevice('tok-1');
    expect(result).toEqual({ id: 'dev-1', type: 'browser', name: 'phone', createdAt: 123 });
  });

  it('getDevice throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(getDevice('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('getDevice throws on a non-401 error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(getDevice('tok-1')).rejects.toThrow('HTTP 500');
  });

  it('getDevice sends a Bearer authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
      return { ok: true, status: 200, json: async () => ({ id: 'dev-1', type: 'browser', name: 'phone', createdAt: 1 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await getDevice('tok-1');
  });

  it('unpairDevice resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(unpairDevice('tok-1')).resolves.toBeUndefined();
  });

  it('unpairDevice throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(unpairDevice('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('unpairDevice sends a Bearer authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await unpairDevice('tok-1');
  });
});
