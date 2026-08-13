import { createHash, randomBytes } from 'node:crypto';
import type { Device, Store } from './store.js';

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ClaimResult = 'ok' | 'not_found' | 'expired' | 'already_claimed' | 'daemon_exists';
export type PollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'complete'; token: string; deviceId: string };

export class PairingService {
  constructor(private store: Store) {}

  async requestPairingCode(deviceName: string): Promise<{ code: string; deviceCode: string; expiresAt: number }> {
    const pairing = await this.store.createPairingCode(deviceName);
    return { code: pairing.code, deviceCode: pairing.deviceCode, expiresAt: pairing.expiresAt };
  }

  /** Called by an already-paired browser to link a daemon's pending pairing code to its account. */
  async claimPairingCode(code: string, userId: string): Promise<ClaimResult> {
    const existingDaemon = await this.store.getDaemonDeviceForUser(userId);
    if (existingDaemon) return 'daemon_exists';
    return this.store.claimPairingCode(code, userId);
  }

  /** Called by the daemon that requested the code, until a browser claims it. */
  async pollPairingCode(deviceCode: string): Promise<PollResult> {
    const pairing = await this.store.getPairingCodeByDeviceCode(deviceCode);
    if (!pairing || pairing.redeemed || pairing.expiresAt < Date.now()) {
      return { status: 'expired' };
    }
    if (!pairing.userId) {
      return { status: 'pending' };
    }
    const { token, device } = await this.mintDeviceToken(pairing.userId, 'daemon', pairing.deviceName);
    await this.store.markPairingCodeRedeemed(deviceCode);
    return { status: 'complete', token, deviceId: device.id };
  }

  /** Called once per browser, immediately after Clerk verification succeeds. */
  async registerBrowserDevice(userId: string, deviceName: string): Promise<{ token: string; device: Device }> {
    return this.mintDeviceToken(userId, 'browser', deviceName);
  }

  async verifyToken(token: string): Promise<Device | undefined> {
    return this.store.getDeviceByTokenHash(hashToken(token));
  }

  private async mintDeviceToken(
    userId: string,
    type: 'daemon' | 'browser',
    name: string
  ): Promise<{ token: string; device: Device }> {
    const token = generateToken();
    const device = await this.store.createDevice({ userId, type, name, tokenHash: hashToken(token) });
    return { token, device };
  }
}
