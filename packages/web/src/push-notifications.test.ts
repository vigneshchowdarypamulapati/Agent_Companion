import { describe, it, expect, afterEach, vi } from 'vitest';
import * as pushApi from './api/push';
import {
  isPushSupported,
  getPermissionState,
  getExistingSubscriptionState,
  enablePush,
  disablePush,
  urlBase64ToUint8Array,
  type PushEnvironment,
} from './push-notifications';

function fakeEnvironment(overrides: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    isSupported: () => true,
    getPermission: () => 'default',
    requestPermission: async () => 'granted',
    getRegistration: async () => {
      throw new Error('getRegistration not stubbed for this test');
    },
    ...overrides,
  };
}

describe('push-notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('urlBase64ToUint8Array', () => {
    it('decodes a base64url string into the matching bytes', () => {
      // "hi" encodes to "aGk" in base64url
      expect(Array.from(urlBase64ToUint8Array('aGk'))).toEqual([104, 105]);
    });
  });

  describe('isPushSupported', () => {
    it('delegates to the environment', () => {
      expect(isPushSupported(fakeEnvironment({ isSupported: () => false }))).toBe(false);
      expect(isPushSupported(fakeEnvironment({ isSupported: () => true }))).toBe(true);
    });
  });

  describe('getPermissionState', () => {
    it('delegates to the environment', () => {
      expect(getPermissionState(fakeEnvironment({ getPermission: () => 'denied' }))).toBe('denied');
    });
  });

  describe('getExistingSubscriptionState', () => {
    it('returns subscribed when a subscription exists', async () => {
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => ({}) } }) as any,
      });
      expect(await getExistingSubscriptionState(env)).toBe('subscribed');
    });

    it('returns unsubscribed when there is no subscription', async () => {
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => undefined } }) as any,
      });
      expect(await getExistingSubscriptionState(env)).toBe('unsubscribed');
    });

    it('returns unsubscribed without checking the registration when push is unsupported', async () => {
      const getRegistration = vi.fn();
      const env = fakeEnvironment({ isSupported: () => false, getRegistration });
      expect(await getExistingSubscriptionState(env)).toBe('unsubscribed');
      expect(getRegistration).not.toHaveBeenCalled();
    });
  });

  describe('enablePush', () => {
    it('subscribes and saves the subscription', async () => {
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('aGk');
      const savePushSubscription = vi.spyOn(pushApi, 'savePushSubscription').mockResolvedValue(undefined);
      const subscribe = vi.fn(async () => ({
        toJSON: () => ({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } }),
      }));
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { subscribe } }) as any,
      });

      await enablePush('tok-1', env);

      expect(subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
      );
      expect(savePushSubscription).toHaveBeenCalledWith('tok-1', {
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'p', auth: 'a' },
      });
    });

    it('throws if the relay has no VAPID key configured', async () => {
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue(undefined);

      await expect(enablePush('tok-1', fakeEnvironment())).rejects.toThrow('not available');
    });

    it('throws if permission is not granted', async () => {
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('aGk');
      const env = fakeEnvironment({ requestPermission: async () => 'denied' });

      await expect(enablePush('tok-1', env)).rejects.toThrow('not granted');
    });
  });

  describe('disablePush', () => {
    it('unsubscribes and clears the subscription on the relay', async () => {
      const unsubscribe = vi.fn(async () => true);
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }) as any,
      });
      const deletePushSubscription = vi.spyOn(pushApi, 'deletePushSubscription').mockResolvedValue(undefined);

      await disablePush('tok-1', env);

      expect(unsubscribe).toHaveBeenCalled();
      expect(deletePushSubscription).toHaveBeenCalledWith('tok-1');
    });

    it('still clears the relay-side subscription when there is no browser-side subscription', async () => {
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => undefined } }) as any,
      });
      const deletePushSubscription = vi.spyOn(pushApi, 'deletePushSubscription').mockResolvedValue(undefined);

      await disablePush('tok-1', env);

      expect(deletePushSubscription).toHaveBeenCalledWith('tok-1');
    });
  });
});
