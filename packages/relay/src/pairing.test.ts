import { describe, it, expect } from 'vitest';
import { PairingService } from './pairing.js';
import { InMemoryStore } from './in-memory-store.js';

describe('PairingService', () => {
  it('a daemon requests a code, a browser claims it, and the daemon polls it to completion', async () => {
    const pairing = new PairingService(new InMemoryStore());

    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('ok');

    const result = await pairing.pollPairingCode(deviceCode);
    expect(result.status).toBe('complete');
    if (result.status === 'complete') {
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);
      const device = await pairing.verifyToken(result.token);
      expect(device?.type).toBe('daemon');
      expect(device?.name).toBe('my-laptop');
      expect(device?.userId).toBe('user-1');
    }
  });

  it('polling before the code is claimed returns pending', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { deviceCode } = await pairing.requestPairingCode('my-laptop');

    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'pending' });
  });

  it('claiming an unknown code returns not_found', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.claimPairingCode('000000', 'user-1')).toBe('not_found');
  });

  it('a code cannot be claimed twice', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode('my-laptop');

    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('ok');
    expect(await pairing.claimPairingCode(code, 'user-2')).toBe('already_claimed');
  });

  it('claiming a code is rejected when the account already has a daemon device', async () => {
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'existing', tokenHash: 'hash-1' });

    const { code } = await pairing.requestPairingCode('new-laptop');

    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('daemon_exists');
  });

  it('polling an unknown device code returns expired', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.pollPairingCode('not-a-real-device-code')).toEqual({ status: 'expired' });
  });

  it('polling again after completion returns expired, not a second token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    await pairing.claimPairingCode(code, 'user-1');
    await pairing.pollPairingCode(deviceCode);

    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'expired' });
  });

  it('registerBrowserDevice mints a browser device token for the given user', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const result = await pairing.registerBrowserDevice('user-1', 'phone');

    expect(result.device.type).toBe('browser');
    expect(result.device.name).toBe('phone');
    expect(result.device.userId).toBe('user-1');
    const found = await pairing.verifyToken(result.token);
    expect(found?.id).toBe(result.device.id);
  });

  it('verifyToken returns undefined for a bogus token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.verifyToken('not-a-real-token')).toBeUndefined();
  });
});
