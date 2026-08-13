/**
 * Minimal fixed-window-per-key rate limiter, in memory.
 *
 * Deliberately not backed by Redis or an npm package: the relay is a single
 * process today (see PubSub's own "in-memory only, no horizontal scaling yet"
 * status in README.md), so a per-process counter is exactly as strong as the
 * deployment it protects. When PubSub grows a shared backend, this should
 * follow it.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private maxAttempts: number,
    private windowMs: number,
    private now: () => number = Date.now
  ) {}

  /** Records an attempt for `key` and returns whether it's within the allowed rate. */
  attempt(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.maxAttempts) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }
}
