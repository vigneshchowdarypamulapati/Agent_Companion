import { describe, it, expect } from 'vitest';
import { resolveTrustProxyHops } from './trust-proxy.js';

describe('resolveTrustProxyHops', () => {
  it('throws in production when unset', () => {
    expect(() => resolveTrustProxyHops(undefined, 'production')).toThrow(
      /COMPANION_RELAY_TRUST_PROXY must be set explicitly/
    );
  });

  it('starts with the configured hop count in production when set', () => {
    expect(resolveTrustProxyHops('2', 'production')).toBe(2);
    expect(resolveTrustProxyHops('0', 'production')).toBe(0);
  });

  it('defaults to 0 in development or test when unset', () => {
    expect(resolveTrustProxyHops(undefined, 'development')).toBe(0);
    expect(resolveTrustProxyHops(undefined, 'test')).toBe(0);
  });

  it('parses a valid non-negative integer regardless of environment', () => {
    expect(resolveTrustProxyHops('1', 'development')).toBe(1);
    expect(resolveTrustProxyHops('3', 'test')).toBe(3);
  });

  it('rejects a non-integer value regardless of environment', () => {
    expect(() => resolveTrustProxyHops('not-a-number', 'development')).toThrow(
      /must be a non-negative integer/
    );
    expect(() => resolveTrustProxyHops('1.5', 'production')).toThrow(
      /must be a non-negative integer/
    );
  });

  it('rejects a negative value regardless of environment', () => {
    expect(() => resolveTrustProxyHops('-1', 'development')).toThrow(
      /must be a non-negative integer/
    );
  });

  // I1 regression coverage: three real deployment paths that used to defeat
  // the fail-fast check entirely.
  describe('the three ways the fail-fast check used to be defeated (I1)', () => {
    it('throws when NODE_ENV is unset, instead of silently defaulting to 0', () => {
      // Before this fix: undefined nodeEnv fell into the "outside production"
      // branch and returned 0 with no error at all — the exact failure mode
      // of a bare VPS/systemd deploy that forgets to set NODE_ENV.
      expect(() => resolveTrustProxyHops(undefined, undefined)).toThrow(
        /COMPANION_RELAY_TRUST_PROXY must be set explicitly/
      );
      expect(() => resolveTrustProxyHops(undefined, undefined)).toThrow(/NODE_ENV is unset/);
    });

    it('treats an empty string the same as unset — does not silently resolve to 0', () => {
      // Before this fix: Number('') === 0, so an empty-string env var (which
      // some PaaS UIs and `KEY=` lines produce) passed the `raw === undefined`
      // check and returned 0 silently.
      expect(() => resolveTrustProxyHops('', 'production')).toThrow(
        /COMPANION_RELAY_TRUST_PROXY must be set explicitly/
      );
      expect(resolveTrustProxyHops('', 'development')).toBe(0);
    });

    it('treats a whitespace-only string the same as unset', () => {
      expect(() => resolveTrustProxyHops('   ', 'production')).toThrow(
        /COMPANION_RELAY_TRUST_PROXY must be set explicitly/
      );
      expect(resolveTrustProxyHops('  ', 'test')).toBe(0);
    });

    it('accepts a value with surrounding whitespace once trimmed', () => {
      expect(resolveTrustProxyHops(' 2 ', 'production')).toBe(2);
    });
  });
});
