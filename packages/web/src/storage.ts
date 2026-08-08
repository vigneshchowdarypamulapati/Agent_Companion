export interface DeviceCredentials {
  token: string;
  deviceId: string;
}

const STORAGE_KEY = 'companion.device';

/**
 * Malformed stored JSON returns undefined (prompting re-pair) rather than
 * throwing — unlike the daemon's equivalent file-based check, a corrupted
 * localStorage entry shouldn't hard-fail a page load with no diagnostic
 * path a typical user could act on.
 */
export function getStoredCredentials(): DeviceCredentials | undefined {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceCredentials>;
    if (typeof parsed.token === 'string' && typeof parsed.deviceId === 'string') {
      return { token: parsed.token, deviceId: parsed.deviceId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function storeCredentials(credentials: DeviceCredentials): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}

export function clearStoredCredentials(): void {
  localStorage.removeItem(STORAGE_KEY);
}
