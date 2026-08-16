import { describe, it, expect, vi, afterEach } from 'vitest';
import { isHttpSurfaceEnabled, connectWithRetry, noControlChannelConfiguredError } from './main.js';

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

/**
 * Regression coverage for: a single relay-connect failure used to be caught
 * once, logged, and then main() returned — and with the local HTTP surface
 * now off by default, nothing was left holding the Node event loop open, so
 * the daemon exited 0 immediately (a supervisor reads that as a clean,
 * intentional shutdown and won't restart it). connectWithRetry is the fix:
 * it must never give up and return control after only one failure — these
 * tests drive a fake clock through several failures to prove it keeps
 * retrying (and therefore keeps a pending timer alive) instead of
 * silently completing.
 */
describe('connectWithRetry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resolve after a single failure — it keeps retrying until connectOnce succeeds', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const errors: unknown[] = [];
    const connectOnce = vi.fn(async () => {
      calls++;
      if (calls < 4) throw new Error(`ECONNREFUSED (attempt ${calls})`);
    });

    const promise = connectWithRetry(connectOnce, {
      onError: (err) => errors.push(err),
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
    });

    // First attempt happens synchronously (well, on the first microtask
    // turn) before any timer exists — flush that before advancing the clock.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    // Not resolved after the first failure — this is the regression itself:
    // the old code returned control to the caller right here.
    expect(await Promise.race([promise.then(() => 'resolved'), Promise.resolve('pending')])).toBe(
      'pending'
    );

    await vi.advanceTimersByTimeAsync(100); // backoff after attempt 1
    await vi.advanceTimersByTimeAsync(200); // backoff after attempt 2 (doubled)
    await vi.advanceTimersByTimeAsync(400); // backoff after attempt 3 (doubled again)

    await promise;
    expect(calls).toBe(4);
    expect(errors).toHaveLength(3);
  });

  it('retries indefinitely (no built-in attempt cap) rather than throwing', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let errorCount = 0;
    const connectOnce = vi.fn(async () => {
      calls++;
      throw new Error('relay unreachable');
    });

    const promise = connectWithRetry(connectOnce, {
      onError: () => {
        errorCount++;
      },
      initialBackoffMs: 10,
      maxBackoffMs: 40,
    });
    // Swallow so the still-pending promise isn't reported as an unhandled
    // rejection by the test runner once the test itself finishes.
    promise.catch(() => {});

    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(40);
    }

    expect(calls).toBeGreaterThan(10);
    expect(errorCount).toBe(calls);
  });

  it('caps backoff at maxBackoffMs instead of growing unbounded', async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const sleepFn = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let calls = 0;
    const connectOnce = vi.fn(async () => {
      calls++;
      if (calls < 6) throw new Error('down');
    });

    await connectWithRetry(connectOnce, {
      onError: () => {},
      sleepFn,
      initialBackoffMs: 100,
      maxBackoffMs: 300,
    });

    expect(delays).toEqual([100, 200, 300, 300, 300]);
  });
});

/**
 * Regression coverage for I3: a second, distinct instance of the exit-0 shape above, surviving
 * one branch over. connectWithRetry fixed "relay unreachable at startup" from exiting 0 — but a
 * daemon started with the *default* configuration (no COMPANION_RELAY_URL, HTTP surface off)
 * never calls connectWithRetry at all, so nothing holds the event loop open and the process
 * still exits 0, indistinguishable from a clean shutdown to a supervisor.
 */
describe('noControlChannelConfiguredError', () => {
  it('returns an error when neither channel is configured', () => {
    const error = noControlChannelConfiguredError(false, undefined);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/COMPANION_RELAY_URL/);
    expect(error?.message).toMatch(/COMPANION_DAEMON_HTTP/);
  });

  it('returns undefined when the local HTTP surface is enabled', () => {
    expect(noControlChannelConfiguredError(true, undefined)).toBeUndefined();
  });

  it('returns undefined when a relay URL is configured', () => {
    expect(noControlChannelConfiguredError(false, 'ws://localhost:8787')).toBeUndefined();
  });

  it('returns undefined when both are configured', () => {
    expect(noControlChannelConfiguredError(true, 'ws://localhost:8787')).toBeUndefined();
  });

  it('treats an empty-string relay URL as not configured', () => {
    // process.env values are always strings; an accidentally-empty COMPANION_RELAY_URL=
    // must not count as "configured" (main.ts's `if (RELAY_URL)` already treats '' as falsy,
    // this just documents that this check agrees).
    expect(noControlChannelConfiguredError(false, '')).toBeInstanceOf(Error);
  });
});

/**
 * End-to-end version of the same regression, driven through the real entrypoint function
 * rather than the extracted pure check above: with both env vars unset (main.ts's module-scope
 * defaults — the state of a fresh checkout's `npm start` per the daemon README), main() must
 * reject before doing anything else, rather than resolving and letting the process fall through
 * to exit 0. Uses vi.resetModules() + a fresh dynamic import because HTTP_ENABLED/RELAY_URL are
 * computed from process.env once, at module-evaluation time (same pattern as
 * packages/web/src/config.test.ts).
 */
describe('main() with no control channel configured (I3 end-to-end)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('rejects instead of resolving, so the process exits non-zero instead of 0', async () => {
    vi.stubEnv('COMPANION_RELAY_URL', '');
    vi.stubEnv('COMPANION_DAEMON_HTTP', '');
    vi.resetModules();
    const mod = await import('./main.js');
    await expect(mod.main()).rejects.toThrow(/No control channel is configured/);
  });
});
