import { describe, it, expect } from 'vitest';
import { PushSubscriptionPayload } from './push.js';

describe('PushSubscriptionPayload schema', () => {
  it('accepts a valid push subscription', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://push.example.com/abc123',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a subscription missing keys', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://push.example.com/abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a subscription missing the auth key', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://push.example.com/abc123',
      keys: { p256dh: 'key-p256dh' },
    });
    expect(result.success).toBe(false);
  });
});
