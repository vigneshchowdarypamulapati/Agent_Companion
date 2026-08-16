/**
 * Resolves the Express `trust proxy` hop count from the raw
 * `COMPANION_RELAY_TRUST_PROXY` environment variable.
 *
 * Factored out of main.ts (rather than inlined there like the other env
 * checks) purely so the production fail-fast branch below is unit
 * testable without pulling in main.ts's side effects (loading .env,
 * requiring DATABASE_URL/CLERK_SECRET_KEY, connecting to Postgres, and
 * starting the HTTP listener all run at module-import time in main.ts).
 *
 * There is no safe default for this value:
 *   - 0 (trust nothing) is wrong behind a real proxy/load balancer: every
 *     client collapses into the proxy's single IP, so the IP-keyed
 *     `/pairing/request-code` and pre-auth `/devices/register-browser`
 *     rate limiters both become one shared global bucket — roughly 80
 *     unauthenticated requests then lock out every user.
 *   - A non-zero value is wrong with no proxy in front: it makes Express
 *     trust a client-supplied `X-Forwarded-For` header, so any caller can
 *     forge a fresh IP on every request and bypass IP-keyed rate limiting
 *     entirely.
 * Because the two mistakes are opposite and each is silent (no error, just
 * quietly-wrong rate limiting), deployments must state the real hop count
 * explicitly. Outside local dev/test, no safe default exists, so the check
 * below fails loud rather than guessing.
 *
 * The "is this production" test below is deliberately the inverse of the
 * usual `nodeEnv === 'production'` check: it treats anything that is *not*
 * explicitly `'development'` or `'test'` as production-like, including an
 * unset `NODE_ENV`. A bare VPS/systemd deploy that forgets to set
 * `NODE_ENV=production` is a common, realistic operator mistake, and the
 * failure mode of guessing wrong here (every client's rate limiting
 * silently collapses into one shared bucket) is worse than the failure mode
 * of a false-positive startup error asking the operator to set
 * `COMPANION_RELAY_TRUST_PROXY` explicitly. Local dev and the test suite
 * both set `NODE_ENV` themselves (`test` via Vitest; `development` is the
 * documented local-dev value), so this does not affect either.
 */
function isProductionLike(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

export function resolveTrustProxyHops(
  raw: string | undefined,
  nodeEnv: string | undefined
): number {
  // A blank or whitespace-only value is treated identically to unset —
  // `Number('')` is `0`, so without this an empty-string env var (which
  // some PaaS UIs and `KEY=` lines in a compose/env file produce for an
  // "unset" variable) would silently resolve to 0 instead of taking the
  // fail-fast path below.
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') {
    if (isProductionLike(nodeEnv)) {
      throw new Error(
        'COMPANION_RELAY_TRUST_PROXY must be set explicitly outside local development/test ' +
          `(NODE_ENV is ${nodeEnv === undefined ? 'unset' : JSON.stringify(nodeEnv)}, and only ` +
          '"development" and "test" are treated as safe to default). It is the number of ' +
          'reverse proxies/load balancers in front of this relay — 0 means "no proxy, trust ' +
          'nothing." There is no safe default: guessing wrong breaks per-IP rate limiting ' +
          "either way (too low collapses every real client into the proxy's single IP and " +
          'locks out all users; too high lets a client spoof X-Forwarded-For and bypass rate ' +
          'limiting entirely). Set it to the real hop count for this deployment, and set ' +
          'NODE_ENV=production so this check reflects that intent.'
      );
    }
    return 0;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      'COMPANION_RELAY_TRUST_PROXY must be a non-negative integer (the number of reverse ' +
        'proxies/load balancers in front of this relay) if set at all. Leave it unset outside ' +
        'production if there is no proxy or the topology is unknown.'
    );
  }
  return parsed;
}
