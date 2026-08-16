import { createHash, randomBytes } from 'node:crypto';
import { MAX_PAIRING_CODE_ATTEMPTS, normalizePairingCode, type Device, type Store } from './store.js';

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

  /**
   * Called by an already-paired browser to link a daemon's pending pairing
   * code to its account. The code is normalized (uppercased, hyphens/
   * whitespace stripped) before matching, so a human can type it exactly as
   * displayed (`XXXX-XXXX`), all lowercase, or as one unbroken run of
   * characters — the store itself only ever sees/stores the canonical form.
   */
  async claimPairingCode(code: string, userId: string): Promise<ClaimResult> {
    const existingDaemon = await this.store.getDaemonDeviceForUser(userId);
    if (existingDaemon) return 'daemon_exists';
    return this.store.claimPairingCode(normalizePairingCode(code), userId);
  }

  /** Called by the daemon that requested the code, until a browser claims it. */
  async pollPairingCode(deviceCode: string): Promise<PollResult> {
    const pairing = await this.store.getPairingCodeByDeviceCode(deviceCode);
    // A code that's hit the failed-claim cap (MAX_PAIRING_CODE_ATTEMPTS) is
    // reported 'expired' here too, exactly like true TTL expiry — no
    // separate status leaks that a lockout (rather than ordinary expiry)
    // happened. In practice this only ever fires for a code that was
    // already claimed and then repeatedly re-claimed by someone else, but
    // checking it unconditionally means a locked-out code can never be
    // polled to completion no matter which path locked it.
    if (
      !pairing ||
      pairing.redeemed ||
      pairing.expiresAt < Date.now() ||
      pairing.failedAttempts >= MAX_PAIRING_CODE_ATTEMPTS
    ) {
      return { status: 'expired' };
    }
    if (!pairing.userId) {
      return { status: 'pending' };
    }
    // The one-daemon-per-account rule has to be re-checked *here*, not only at
    // claim time: the daemon device row doesn't exist until this poll mints it,
    // so two codes claimed back-to-back both pass the claim-time check and only
    // this second check stops the second one from minting a second daemon.
    // 'expired' rather than a new status: from the daemon's point of view this
    // pairing attempt has failed permanently, exactly like a real expiry.
    const existingDaemon = await this.store.getDaemonDeviceForUser(pairing.userId);
    if (existingDaemon) {
      return { status: 'expired' };
    }
    // Redeem before minting: this is the atomic gate, so a concurrent poll that
    // loses the race gets `undefined` and never mints a duplicate device.
    const redeemed = await this.store.redeemPairingCode(deviceCode);
    if (!redeemed) {
      return { status: 'expired' };
    }
    const { token, device } = await this.mintDeviceToken(redeemed.userId!, 'daemon', redeemed.deviceName);
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
