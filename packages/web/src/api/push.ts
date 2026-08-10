import type { PushSubscriptionPayload } from '@companion/protocol';
import { RELAY_HTTP_URL } from '../config';
import { UnauthorizedError } from './sessions';

export async function getVapidPublicKey(): Promise<string | undefined> {
  const res = await fetch(`${RELAY_HTTP_URL}/push/vapid-public-key`);
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Failed to fetch the VAPID public key: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { publicKey: string };
  return body.publicKey;
}

export async function savePushSubscription(token: string, subscription: PushSubscriptionPayload): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/push-subscription`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(subscription),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to save push subscription: HTTP ${res.status}`);
  }
}

export async function deletePushSubscription(token: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/push-subscription`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to delete push subscription: HTTP ${res.status}`);
  }
}
