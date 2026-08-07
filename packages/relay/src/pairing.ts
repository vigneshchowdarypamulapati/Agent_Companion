import { createHash, randomBytes } from 'node:crypto';
import type { Device, Store } from './store.js';

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PairingService {
  constructor(private store: Store) {}

  async requestPairingCode(): Promise<{ code: string; expiresAt: number }> {
    const user = await this.store.getOrCreateDefaultUser();
    const pairing = await this.store.createPairingCode(user.id);
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  async redeemPairingCode(
    code: string,
    deviceType: 'daemon' | 'browser',
    deviceName: string
  ): Promise<{ token: string; device: Device } | undefined> {
    const pairing = await this.store.consumePairingCode(code);
    if (!pairing) return undefined;
    const token = generateToken();
    const device = await this.store.createDevice({
      userId: pairing.userId,
      type: deviceType,
      name: deviceName,
      tokenHash: hashToken(token),
    });
    return { token, device };
  }

  async verifyToken(token: string): Promise<Device | undefined> {
    return this.store.getDeviceByTokenHash(hashToken(token));
  }
}
