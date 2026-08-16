import { describe, it, expect, afterEach, vi } from 'vitest';
import { claimPairingCode } from './pairing';
import { UnauthorizedError } from './sessions';

describe('claimPairingCode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves when the relay accepts the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(claimPairingCode('tok-1', 'ABCD-1234')).resolves.toBeUndefined();
  });

  it('posts the code with a Bearer authorization header', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/\/pairing\/claim$/);
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
      expect(JSON.parse(init!.body as string)).toEqual({ code: 'ABCD-1234' });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    await claimPairingCode('tok-1', 'ABCD-1234');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(claimPairingCode('bad-token', 'ABCD-1234')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws the relay's error message when the response body carries one", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'Pairing code already claimed' }) }))
    );
    await expect(claimPairingCode('tok-1', 'ABCD-1234')).rejects.toThrow('Pairing code already claimed');
  });

  it('throws a generic HTTP message when the body cannot be parsed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      }))
    );
    await expect(claimPairingCode('tok-1', 'ABCD-1234')).rejects.toThrow('HTTP 500');
  });
});
