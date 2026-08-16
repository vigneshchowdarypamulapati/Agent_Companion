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
 * quietly-wrong rate limiting), production deployments must state the real
 * hop count explicitly. Outside production (local dev, CI, tests), no
 * proxy is normally involved, so the historical default of 0 is kept and
 * nothing extra is required to run the relay locally.
 */
export function resolveTrustProxyHops(
  raw: string | undefined,
  nodeEnv: string | undefined
): number {
  if (raw === undefined) {
    if (nodeEnv === 'production') {
      throw new Error(
        'COMPANION_RELAY_TRUST_PROXY must be set explicitly in production. It is the number ' +
          'of reverse proxies/load balancers in front of this relay — 0 means "no proxy, ' +
          'trust nothing." There is no safe default: guessing wrong breaks per-IP rate ' +
          "limiting either way (too low collapses every real client into the proxy's single " +
          'IP and locks out all users; too high lets a client spoof X-Forwarded-For and ' +
          'bypass rate limiting entirely). Set it to the real hop count for this deployment.'
      );
    }
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      'COMPANION_RELAY_TRUST_PROXY must be a non-negative integer (the number of reverse ' +
        'proxies/load balancers in front of this relay) if set at all. Leave it unset outside ' +
        'production if there is no proxy or the topology is unknown.'
    );
  }
  return parsed;
}
