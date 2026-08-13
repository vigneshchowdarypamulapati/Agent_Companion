import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to maxAttempts within the window and rejects the next one', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, 1000, () => now);

    expect(limiter.attempt('k')).toBe(true);
    expect(limiter.attempt('k')).toBe(true);
    expect(limiter.attempt('k')).toBe(true);
    expect(limiter.attempt('k')).toBe(false);
  });

  it('keeps rejecting while still inside the window', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(1, 1000, () => now);

    expect(limiter.attempt('k')).toBe(true);
    now += 999;
    expect(limiter.attempt('k')).toBe(false);
  });

  it('allows again once the window has passed', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(2, 1000, () => now);

    expect(limiter.attempt('k')).toBe(true);
    expect(limiter.attempt('k')).toBe(true);
    expect(limiter.attempt('k')).toBe(false);

    now += 1001;
    expect(limiter.attempt('k')).toBe(true);
  });

  it('tracks different keys independently', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(1, 1000, () => now);

    expect(limiter.attempt('a')).toBe(true);
    expect(limiter.attempt('a')).toBe(false);
    expect(limiter.attempt('b')).toBe(true);
  });

  it('a rejected attempt does not extend the window (it is not recorded)', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(1, 1000, () => now);

    expect(limiter.attempt('k')).toBe(true);
    now += 500;
    expect(limiter.attempt('k')).toBe(false);
    // The original hit ages out at +1000 regardless of the rejected attempt at +500.
    now += 501;
    expect(limiter.attempt('k')).toBe(true);
  });
});
