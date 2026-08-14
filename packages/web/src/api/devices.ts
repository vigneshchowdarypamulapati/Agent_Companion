import { RELAY_HTTP_URL } from '../config';
import { UnauthorizedError } from './sessions';

export interface DeviceInfo {
  id: string;
  type: 'daemon' | 'browser';
  name: string;
  createdAt: number;
}

export async function getDevice(token: string): Promise<DeviceInfo> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch device info: HTTP ${res.status}`);
  }
  return (await res.json()) as DeviceInfo;
}

export async function unpairDevice(token: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/unpair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to unpair device: HTTP ${res.status}`);
  }
}

export async function getDaemonStatus(token: string): Promise<boolean> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/daemon-status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch daemon status: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { paired: boolean };
  return body.paired;
}

export interface RegisterBrowserResult {
  token: string;
  deviceId: string;
}

export async function registerBrowserDevice(clerkToken: string): Promise<RegisterBrowserResult> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/register-browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${clerkToken}` },
    body: JSON.stringify({ deviceName: guessDeviceName() }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to register this browser: HTTP ${res.status}`);
  }
  return (await res.json()) as RegisterBrowserResult;
}

function guessDeviceName(): string {
  return typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.slice(0, 60) : 'Browser';
}
