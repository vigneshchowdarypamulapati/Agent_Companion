import { RELAY_HTTP_URL } from '../config';

export interface PairingCodeResult {
  code: string;
  expiresAt: number;
}

export async function requestPairingCode(): Promise<PairingCodeResult> {
  const res = await fetch(`${RELAY_HTTP_URL}/pairing/request-code`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Failed to request a pairing code: HTTP ${res.status}`);
  }
  return (await res.json()) as PairingCodeResult;
}

export interface RedeemResult {
  token: string;
  deviceId: string;
}

export async function redeemPairingCode(code: string): Promise<RedeemResult> {
  const res = await fetch(`${RELAY_HTTP_URL}/pairing/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceType: 'browser', deviceName: guessDeviceName() }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to redeem pairing code: HTTP ${res.status}`);
  }
  return (await res.json()) as RedeemResult;
}

function guessDeviceName(): string {
  return typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.slice(0, 60) : 'Browser';
}
