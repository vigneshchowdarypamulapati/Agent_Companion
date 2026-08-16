import { RELAY_HTTP_URL } from '../config';
import { UnauthorizedError } from './sessions';

/**
 * Links a daemon's pending pairing code to this browser's account.
 * Authenticated with this browser's own companion device token, exactly like
 * every other call in `api/` — the relay derives the owning account from it.
 * The code is sent exactly as typed; the relay normalizes it (case-
 * insensitive, hyphens/whitespace ignored) before matching.
 */
export async function claimPairingCode(token: string, code: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/pairing/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to claim pairing code: HTTP ${res.status}`);
  }
}
