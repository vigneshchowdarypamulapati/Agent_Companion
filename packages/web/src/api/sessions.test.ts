import { describe, it, expect, afterEach, vi } from 'vitest';
import { getActiveSessions, getSessionEvents, dismissSession, UnauthorizedError } from './sessions';

describe('sessions API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getActiveSessions returns the array on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: 'sess-1', status: 'running' }] }))
    );
    const result = await getActiveSessions('tok-1');
    expect(result).toEqual([{ id: 'sess-1', status: 'running' }]);
  });

  it('getActiveSessions returns an empty array on 200 with no sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    expect(await getActiveSessions('tok-1')).toEqual([]);
  });

  it('getActiveSessions throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(getActiveSessions('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('dismissSession resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(dismissSession('tok-1', 'sess-1')).resolves.toBeUndefined();
  });

  it('dismissSession throws on 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}) })));
    await expect(dismissSession('tok-1', 'sess-1')).rejects.toThrow('not stopped');
  });

  it('dismissSession throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(dismissSession('bad-token', 'sess-1')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('dismissSession URL-encodes the session id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/sessions/sess%20with%20space/dismiss');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await dismissSession('tok-1', 'sess with space');
  });

  it('getSessionEvents includes the since query param when provided', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.toString()).toContain('since=5');
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    await getSessionEvents('tok-1', 'sess-1', 5);
  });

  it('getSessionEvents omits the since query param when not provided', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.toString()).not.toContain('since=');
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    await getSessionEvents('tok-1', 'sess-1');
  });
});
