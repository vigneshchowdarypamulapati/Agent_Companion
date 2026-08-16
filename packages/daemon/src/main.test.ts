import { describe, it, expect } from 'vitest';
import { isHttpSurfaceEnabled } from './main.js';

describe('isHttpSurfaceEnabled', () => {
  it('is off when the env var is unset', () => {
    expect(isHttpSurfaceEnabled(undefined)).toBe(false);
  });

  it('is off for an empty string', () => {
    expect(isHttpSurfaceEnabled('')).toBe(false);
  });

  it('is on for "1"', () => {
    expect(isHttpSurfaceEnabled('1')).toBe(true);
  });

  it('is on for "true" in any casing', () => {
    expect(isHttpSurfaceEnabled('true')).toBe(true);
    expect(isHttpSurfaceEnabled('TRUE')).toBe(true);
    expect(isHttpSurfaceEnabled('True')).toBe(true);
  });

  it('is off for anything else, including near-misses', () => {
    expect(isHttpSurfaceEnabled('0')).toBe(false);
    expect(isHttpSurfaceEnabled('false')).toBe(false);
    expect(isHttpSurfaceEnabled('yes')).toBe(false);
    expect(isHttpSurfaceEnabled('2')).toBe(false);
  });
});
