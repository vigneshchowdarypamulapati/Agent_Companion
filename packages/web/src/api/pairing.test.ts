import { describe, it, expect, afterEach, vi } from 'vitest';
import { requestPairingCode, redeemPairingCode } from './pairing';

describe('pairing API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requestPairingCode returns the code and expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ code: '123456', expiresAt: 999 }) }))
    );

    const result = await requestPairingCode();
    expect(result).toEqual({ code: '123456', expiresAt: 999 });
  });

  it('requestPairingCode throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(requestPairingCode()).rejects.toThrow('HTTP 500');
  });

  it('redeemPairingCode sends deviceType browser and returns the token', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ code: '123456', deviceType: 'browser' });
      return { ok: true, status: 201, json: async () => ({ token: 'tok-1', deviceId: 'dev-1' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await redeemPairingCode('123456');
    expect(result).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });

  it("redeemPairingCode throws the relay's error message on failure", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid or expired pairing code' }),
      }))
    );
    await expect(redeemPairingCode('000000')).rejects.toThrow('Invalid or expired pairing code');
  });
});
