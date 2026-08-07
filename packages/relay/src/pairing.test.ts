import { describe, it, expect } from 'vitest';
import { PairingService } from './pairing.js';
import { InMemoryStore } from './in-memory-store.js';

describe('PairingService', () => {
  it('issues a pairing code that can be redeemed for a device token', async () => {
    const pairing = new PairingService(new InMemoryStore());

    const { code } = await pairing.requestPairingCode();
    const result = await pairing.redeemPairingCode(code, 'daemon', 'my-laptop');

    expect(result).toBeDefined();
    expect(result?.device.type).toBe('daemon');
    expect(result?.device.name).toBe('my-laptop');
    expect(typeof result?.token).toBe('string');
    expect(result?.token.length).toBeGreaterThan(0);
  });

  it('a pairing code cannot be redeemed twice', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode();

    await pairing.redeemPairingCode(code, 'daemon', 'first-device');
    const second = await pairing.redeemPairingCode(code, 'browser', 'second-device');

    expect(second).toBeUndefined();
  });

  it('redeeming an unknown code returns undefined', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.redeemPairingCode('000000', 'daemon', 'x')).toBeUndefined();
  });

  it('verifyToken finds the device that redeemed a valid token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode();
    const result = await pairing.redeemPairingCode(code, 'browser', 'phone');

    const device = await pairing.verifyToken(result!.token);

    expect(device?.id).toBe(result!.device.id);
  });

  it('verifyToken returns undefined for a bogus token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.verifyToken('not-a-real-token')).toBeUndefined();
  });
});
