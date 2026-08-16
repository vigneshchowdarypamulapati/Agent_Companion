import { describe, it, expect, afterEach, vi } from 'vitest';
import { PushSubscriptionPayload } from './push.js';

const KEYS = { p256dh: 'key-p256dh', auth: 'key-auth' };

function payload(endpoint: string) {
  return { endpoint, keys: KEYS };
}

describe('PushSubscriptionPayload schema', () => {
  it.each([
    ['fcm.googleapis.com', 'https://fcm.googleapis.com/fcm/send/abc123'],
    ['updates.push.services.mozilla.com', 'https://updates.push.services.mozilla.com/wpush/v2/abc123'],
    ['push.services.mozilla.com', 'https://push.services.mozilla.com/wpush/v2/abc123'],
    ['notify.windows.com', 'https://notify.windows.com/w/abc123'],
    ['web.push.apple.com', 'https://web.push.apple.com/abc123'],
  ])('accepts an allowed provider host (%s)', (_label, endpoint) => {
    const result = PushSubscriptionPayload.safeParse(payload(endpoint));
    expect(result.success).toBe(true);
  });

  it('accepts a subdomain of an allowed host', () => {
    const result = PushSubscriptionPayload.safeParse(
      payload('https://some-shard.fcm.googleapis.com/fcm/send/abc123')
    );
    expect(result.success).toBe(true);
  });

  it('rejects a subscription missing keys', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a subscription missing the auth key', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh: 'key-p256dh' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an endpoint that is not a valid URL', () => {
    const result = PushSubscriptionPayload.safeParse(payload('not-a-url'));
    expect(result.success).toBe(false);
  });

  it('rejects a non-https endpoint on an allowed host', () => {
    const result = PushSubscriptionPayload.safeParse(payload('http://fcm.googleapis.com/fcm/send/abc123'));
    expect(result.success).toBe(false);
  });

  it('rejects the suffix-boundary bypass (a lookalike host with the allowed host as a prefix, not a suffix)', () => {
    const result = PushSubscriptionPayload.safeParse(
      payload('https://evil-fcm.googleapis.com.attacker.test/x')
    );
    expect(result.success).toBe(false);
  });

  it('rejects a host that merely contains an allowed host as a substring', () => {
    const result = PushSubscriptionPayload.safeParse(
      payload('https://attacker.test/fcm.googleapis.com')
    );
    expect(result.success).toBe(false);
  });

  it('rejects an IPv4 literal host', () => {
    const result = PushSubscriptionPayload.safeParse(payload('https://203.0.113.10/x'));
    expect(result.success).toBe(false);
  });

  it('rejects an IPv6 literal host', () => {
    const result = PushSubscriptionPayload.safeParse(payload('https://[::1]/x'));
    expect(result.success).toBe(false);
  });

  it('rejects localhost', () => {
    const result = PushSubscriptionPayload.safeParse(payload('https://localhost/x'));
    expect(result.success).toBe(false);
  });

  it('rejects an arbitrary internal hostname', () => {
    const result = PushSubscriptionPayload.safeParse(payload('https://internal-metadata.corp/x'));
    expect(result.success).toBe(false);
  });

  it('does not echo the submitted URL back in the rejection message', () => {
    const secretInternalUrl = 'https://internal-metadata.corp/super-secret-path';
    const result = PushSubscriptionPayload.safeParse(payload(secretInternalUrl));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).not.toContain('internal-metadata.corp');
      expect(JSON.stringify(result.error.issues)).not.toContain('super-secret-path');
    }
  });
});

describe('COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST', () => {
  const originalEnv = process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST;
    } else {
      process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST = originalEnv;
    }
    vi.resetModules();
  });

  it('accepts a host added via the env var, and its subdomains, but not unrelated hosts', async () => {
    process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST = 'push.example-provider.test';
    vi.resetModules();
    const { PushSubscriptionPayload: Schema } = await import('./push.js');

    expect(
      Schema.safeParse(payload('https://push.example-provider.test/x')).success
    ).toBe(true);
    expect(
      Schema.safeParse(payload('https://shard1.push.example-provider.test/x')).success
    ).toBe(true);
    expect(
      Schema.safeParse(payload('https://evil-push.example-provider.test.attacker.test/x')).success
    ).toBe(false);
    // Still rejects hosts that were never allowed at all.
    expect(Schema.safeParse(payload('https://not-allowed.test/x')).success).toBe(false);
  });

  // M1 / Minor 5: the allowlist must NOT be read at module import time — the relay's main.ts
  // imports @companion/protocol (transitively) before it calls process.loadEnvFile('.env'), so
  // an import-time read would silently ignore a value set only in .env. It must instead be read
  // lazily, the first time an endpoint is actually validated.

  it('does not throw on import when the allowlist env var is malformed', async () => {
    process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST = 'not a hostname/with a path';
    vi.resetModules();
    await expect(import('./push.js')).resolves.toBeDefined();
  });

  it('fails fast on first validation when the allowlist env var is malformed', async () => {
    process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST = 'not a hostname/with a path';
    vi.resetModules();
    const { PushSubscriptionPayload: Schema } = await import('./push.js');
    expect(() => Schema.safeParse(payload('https://fcm.googleapis.com/fcm/send/abc123'))).toThrow(
      /COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST must be a comma-separated list/
    );
  });

  it('fails fast on first validation when the allowlist env var contains an IP literal', async () => {
    process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST = '203.0.113.10';
    vi.resetModules();
    const { PushSubscriptionPayload: Schema } = await import('./push.js');
    expect(() => Schema.safeParse(payload('https://fcm.googleapis.com/fcm/send/abc123'))).toThrow(
      /COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST must be a comma-separated list/
    );
  });

  it('reads a value set after import (proving the read is lazy, not cached at module load)', async () => {
    delete process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST;
    vi.resetModules();
    const { PushSubscriptionPayload: Schema } = await import('./push.js');
    // Not set at import time — an endpoint on the not-yet-configured extra host is rejected.
    expect(Schema.safeParse(payload('https://push.example-provider.test/x')).success).toBe(false);
    // Set afterwards (simulating main.ts's process.loadEnvFile('.env') running after this
    // package's imports are hoisted) — now honored on the next validation.
    process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST = 'push.example-provider.test';
    expect(Schema.safeParse(payload('https://push.example-provider.test/x')).success).toBe(true);
  });
});
