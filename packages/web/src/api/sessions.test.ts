import { describe, it, expect, afterEach, vi } from 'vitest';
import { getActiveSession, getSessionEvents, UnauthorizedError } from './sessions';

describe('sessions API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getActiveSession returns the session on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'sess-1', status: 'running' }) }))
    );
    const result = await getActiveSession('tok-1');
    expect(result).toMatchObject({ id: 'sess-1' });
  });

  it('getActiveSession returns undefined on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await getActiveSession('tok-1')).toBeUndefined();
  });

  it('getActiveSession throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(getActiveSession('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
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
