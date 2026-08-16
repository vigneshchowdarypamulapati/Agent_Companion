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
    expect(await pairing.claimPairingCode('ZZZZZZZZ', 'user-1')).toBe('not_found');
  });

  it('claiming a code normalizes case, hyphens, and whitespace before matching', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode('my-laptop');
    const grouped = `${code.slice(0, 4)}-${code.slice(4)}`;

    expect(await pairing.claimPairingCode(` ${grouped.toLowerCase()} `, 'user-1')).toBe('ok');
  });

  it('a code is invalidated after 5 failed claims, indistinguishable from expired', async () => {
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('ok');

    for (let i = 0; i < 4; i++) {
      expect(await pairing.claimPairingCode(code, 'user-2')).toBe('already_claimed');
    }
    // The 5th failed attempt trips the lockout.
    expect(await pairing.claimPairingCode(code, 'user-2')).toBe('expired');
    // And it stays that way, not reverting to already_claimed.
    expect(await pairing.claimPairingCode(code, 'user-2')).toBe('expired');

    // The daemon's own poll reports the same 'expired' status — no separate
    // signal leaks that this was a lockout rather than ordinary TTL expiry.
    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'expired' });
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
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    await pairing.claimPairingCode(code, 'user-1');
    await pairing.pollPairingCode(deviceCode);

    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'expired' });
    // And exactly one daemon device was ever minted.
    expect((await store.getDevicesForUser('user-1')).filter((d) => d.type === 'daemon')).toHaveLength(1);
  });

  it('a code that lost the redemption race mints nothing (redeemPairingCode returned undefined)', async () => {
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    await pairing.claimPairingCode(code, 'user-1');
    // Simulate a concurrent poll winning the atomic redeem first.
    expect(await store.redeemPairingCode(deviceCode)).toBeDefined();

    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'expired' });
    expect(await store.getDaemonDeviceForUser('user-1')).toBeUndefined();
  });

  it('a second code claimed before the first daemon polls still never redeems, so only one daemon exists', async () => {
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    const first = await pairing.requestPairingCode('laptop-a');
    const second = await pairing.requestPairingCode('laptop-b');

    // Both claims succeed: at claim time neither daemon device exists yet, which
    // is exactly the race the poll-time re-check has to close.
    expect(await pairing.claimPairingCode(first.code, 'user-1')).toBe('ok');
    expect(await pairing.claimPairingCode(second.code, 'user-1')).toBe('ok');

    expect((await pairing.pollPairingCode(first.deviceCode)).status).toBe('complete');
    expect(await pairing.pollPairingCode(second.deviceCode)).toEqual({ status: 'expired' });

    const daemons = (await store.getDevicesForUser('user-1')).filter((d) => d.type === 'daemon');
    expect(daemons).toHaveLength(1);
    expect(daemons[0].name).toBe('laptop-a');
  });

  it('claiming a second code after the first daemon completed also never redeems', async () => {
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    const first = await pairing.requestPairingCode('laptop-a');
    await pairing.claimPairingCode(first.code, 'user-1');
    expect((await pairing.pollPairingCode(first.deviceCode)).status).toBe('complete');

    // The claim itself is now rejected up front...
    const second = await pairing.requestPairingCode('laptop-b');
    expect(await pairing.claimPairingCode(second.code, 'user-1')).toBe('daemon_exists');
    // ...and even if a claim had slipped through, the poll still refuses.
    await store.claimPairingCode(second.code, 'user-1');
    expect(await pairing.pollPairingCode(second.deviceCode)).toEqual({ status: 'expired' });

    expect((await store.getDevicesForUser('user-1')).filter((d) => d.type === 'daemon')).toHaveLength(1);
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
