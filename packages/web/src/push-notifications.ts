import { getVapidPublicKey, savePushSubscription, deletePushSubscription } from './api/push';

/**
 * Wraps the browser Push/Notification/ServiceWorker APIs behind an injectable interface, the
 * same seam pattern use-relay-connection.ts uses for RelayConnection: jsdom (this project's
 * test environment) implements none of these APIs, so tests construct a plain object matching
 * this shape instead of mutating global browser objects.
 */
export interface PushEnvironment {
  isSupported(): boolean;
  getPermission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getRegistration(): Promise<ServiceWorkerRegistration>;
}

const defaultEnvironment: PushEnvironment = {
  isSupported: () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window,
  getPermission: () => (typeof Notification === 'undefined' ? 'denied' : Notification.permission),
  requestPermission: () => Notification.requestPermission(),
  getRegistration: () => navigator.serviceWorker.ready,
};

/** Web Push's applicationServerKey must be raw bytes, but VAPID public keys are handed around
 * as base64url text — this is the standard decode routine for that conversion. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function isPushSupported(env: PushEnvironment = defaultEnvironment): boolean {
  return env.isSupported();
}

export function getPermissionState(env: PushEnvironment = defaultEnvironment): NotificationPermission {
  return env.getPermission();
}

export async function getExistingSubscriptionState(
  env: PushEnvironment = defaultEnvironment
): Promise<'subscribed' | 'unsubscribed'> {
  if (!env.isSupported()) return 'unsubscribed';
  const registration = await env.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'unsubscribed';
}

export async function enablePush(token: string, env: PushEnvironment = defaultEnvironment): Promise<void> {
  const publicKey = await getVapidPublicKey();
  if (!publicKey) {
    throw new Error('Push notifications are not available on this server');
  }
  const permission = await env.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted');
  }
  const registration = await env.getRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = subscription.toJSON();
  await savePushSubscription(token, {
    endpoint: json.endpoint!,
    keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
  });
}

export async function disablePush(token: string, env: PushEnvironment = defaultEnvironment): Promise<void> {
  const registration = await env.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
  }
  await deletePushSubscription(token);
}
