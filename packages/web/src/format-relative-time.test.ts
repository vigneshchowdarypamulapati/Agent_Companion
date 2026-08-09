import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './format-relative-time';

describe('formatRelativeTime', () => {
  const now = 1_000_000_000;

  it('returns "just now" for under a minute', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });

  it('formats days', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });

  it('clamps a future timestamp to "just now" instead of a negative duration', () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe('just now');
  });
});
