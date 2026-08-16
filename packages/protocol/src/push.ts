import { z } from 'zod';

// Browser push services a Web Push subscription's `endpoint` is legitimately
// ever hosted on. Every UA vendor uses its own fixed domain(s); nothing else
// is a real push service, so anything else is either a mistake or an attempt
// to make the relay POST session data to an arbitrary URL on a schedule
// (see the second .refine() below for what that would enable).
const BASE_ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome/Edge/most Chromium browsers
  'updates.push.services.mozilla.com', // Firefox
  'push.services.mozilla.com', // Firefox (older endpoint host, still issued)
  'notify.windows.com', // Windows/WNS-backed browsers
  'web.push.apple.com', // Safari
];

// Bare hostname (no scheme/path/port), requiring at least one dot so a
// single label like "localhost" can never pass.
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

function isIpLiteral(host: string): boolean {
  // WHATWG URL keeps the brackets on an IPv6 hostname (e.g. "[::1]"); no
  // valid DNS hostname can start with "[", so this alone is a safe test.
  if (host.startsWith('[')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Extra allowed push-endpoint hosts on top of BASE_ALLOWED_PUSH_HOSTS, so a
 * push provider that ships later doesn't require a code change here.
 * Comma-separated. Unset is fine and adds nothing.
 *
 * Deliberately NOT read at module load. `@companion/protocol` is imported
 * by the relay's `main.ts` (via `server.js`) before `main.ts` calls
 * `process.loadEnvFile('.env')` — ESM hoists all of a module's imports
 * ahead of its own top-level code, so anything this package read from
 * `process.env` at import time would see the environment as it was
 * *before* `.env` was loaded, and a value set only in `.env` (the
 * mechanism the relay's README documents for every other
 * `COMPANION_RELAY_*` variable) would be silently ignored. Reading it here,
 * inside the function `isAllowedPushHost` calls on every validation
 * instead, means it's evaluated the first time an endpoint actually needs
 * checking — by which point `main.ts` has already loaded `.env` — so a
 * value set there is honored, and a typo is still caught fast (on the
 * first `POST /devices/push-subscription`, or the first
 * `PushSubscriptionPayload.safeParse` call in a test), just not
 * necessarily at process startup.
 */
function parseExtraAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const hosts = raw.split(',').map((host) => host.trim().toLowerCase());
  for (const host of hosts) {
    if (host.length === 0 || isIpLiteral(host) || !HOSTNAME_PATTERN.test(host)) {
      throw new Error(
        'COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST must be a comma-separated list of bare ' +
          'hostnames if set at all — no scheme, path, port, or IP literals — e.g. ' +
          '"push.example-provider.com,push2.example-provider.com".'
      );
    }
  }
  return hosts;
}

function isAllowedPushHost(hostname: string): boolean {
  const extraAllowedHosts = parseExtraAllowedHosts(process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST);
  const allowed = BASE_ALLOWED_PUSH_HOSTS.length + extraAllowedHosts.length;
  if (allowed === 0) return false;
  for (const host of BASE_ALLOWED_PUSH_HOSTS) {
    // Exact match or a proper "." boundary subdomain match — never a bare
    // .includes()/.endsWith() on the raw suffix, which
    // "evil-fcm.googleapis.com.attacker.test" would slip through.
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  for (const host of extraAllowedHosts) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

export const PushSubscriptionPayload = z.object({
  endpoint: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'endpoint must be an https:// URL' }
    )
    .refine(
      (value) => {
        let hostname: string;
        try {
          hostname = new URL(value).hostname;
        } catch {
          return false;
        }
        // IP literals are rejected outright before the allowlist check —
        // no legitimate push service is one, and this closes the
        // private-range/loopback SSRF cases without needing a range table.
        if (isIpLiteral(hostname)) return false;
        return isAllowedPushHost(hostname);
      },
      {
        // Deliberately does not echo the submitted URL: this message lands
        // in both the HTTP response and server logs, and the endpoint is
        // caller-supplied, unauthenticated-context-adjacent input.
        message:
          'endpoint host is not a recognized browser push service. Set ' +
          'COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST to allow an additional provider.',
      }
    ),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});
export type PushSubscriptionPayload = z.infer<typeof PushSubscriptionPayload>;
