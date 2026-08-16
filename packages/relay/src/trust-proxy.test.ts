import { describe, it, expect } from 'vitest';
import { resolveTrustProxyHops } from './trust-proxy.js';

describe('resolveTrustProxyHops', () => {
  it('throws in production when unset', () => {
    expect(() => resolveTrustProxyHops(undefined, 'production')).toThrow(
      /COMPANION_RELAY_TRUST_PROXY must be set explicitly in production/
    );
  });

  it('starts with the configured hop count in production when set', () => {
    expect(resolveTrustProxyHops('2', 'production')).toBe(2);
    expect(resolveTrustProxyHops('0', 'production')).toBe(0);
  });

  it('defaults to 0 outside production when unset', () => {
    expect(resolveTrustProxyHops(undefined, 'development')).toBe(0);
    expect(resolveTrustProxyHops(undefined, 'test')).toBe(0);
    expect(resolveTrustProxyHops(undefined, undefined)).toBe(0);
  });

  it('parses a valid non-negative integer regardless of environment', () => {
    expect(resolveTrustProxyHops('1', 'development')).toBe(1);
    expect(resolveTrustProxyHops('3', undefined)).toBe(3);
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
});
