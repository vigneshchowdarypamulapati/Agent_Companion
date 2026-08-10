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
