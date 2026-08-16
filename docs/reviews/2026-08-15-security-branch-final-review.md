# Security-hardening branch — final whole-branch review

**Branch:** `security-hardening` (8 commits, `7c58c45..fa31b70`)
**Reviewer:** Senior Security Engineer, cross-task integration pass
**Scope:** cross-task interference, regressions, whether the five fixes actually close
their holes, new attack surface, operational safety, secrets hygiene.
**Method:** read the supplied diff and the current source; ran the daemon, protocol and
web test suites (all green); ran the daemon binary to confirm one behavioural claim;
probed the push validator and the trust-proxy resolver directly against the built
artifacts. Did **not** run the relay suite (truncates a shared database) and made no
file or git-state changes.

**Verdict: merge WITH FIXES.** Nothing here is remotely exploitable as deployed today.
Two Important findings (I1, I2) mean the branch does not fully deliver what two of its
five headline claims say it delivers; both are cheap to fix. I3/I4 are cheap too.

**Counts:** 0 Critical · 4 Important · 9 Minor · 0 secrets-hygiene issues.

---

## 1. Did each fix actually close its hole?

### Finding 1 — destructive Postgres tests: **closed, with a weak edge** (see I4)

`packages/relay/src/postgres-store.test.ts` now reads `COMPANION_TEST_DATABASE_URL`
only, throws at module scope before `createDbClient` is ever called if it is unset, and
re-checks byte-identity against `DATABASE_URL` both at module scope (before
`runMigrations`) and again in `beforeEach` immediately before the `TRUNCATE`. That is a
genuine improvement and the module-scope placement is correct — migrations run in
`beforeAll`, so a guard that only lived in `beforeEach` would have let DDL hit the wrong
database first.

Verified on the local machine without printing any secret: `DATABASE_URL` and
`COMPANION_TEST_DATABASE_URL` are both set, are not byte-identical, and resolve to
*different database names* — so data-level isolation genuinely holds here. They do share
a Neon host, which is fine (Postgres databases are isolated from each other) but means
the operator did not create a separate branch, just a separate database. Worth knowing.

The residual weakness is I4 below: byte-comparison is a weak equality test for a
connection string.

### Finding 2 — daemon local HTTP surface: **closed. I could not construct a bypass.**

All three layers are present and correctly ordered in
`packages/daemon/src/http-server.ts`:

```
app.use(hostAllowlist());   // 403, before anything
app.use(bearerAuth(token)); // 401, before body parsing
app.use(express.json());
```

I attempted the following bypasses against the actual code and none work:

| Attempt | Result |
|---|---|
| Malicious page DNS-rebinds `attacker.test` → `127.0.0.1`, `POST /sessions` | Browser sends `Host: attacker.test:4310` → **403** before any handler |
| Malicious page fetches `http://127.0.0.1:4310/sessions` directly with `Authorization` | `Authorization` is not a CORS-safelisted header → browser sends an `OPTIONS` preflight with **no** `Authorization` → **401**, no CORS headers → real request never sent |
| Same, `mode: 'no-cors'` / HTML form POST (no preflight) | No `Authorization` header → **401** |
| Request with no `Host` header at all (HTTP/1.0) | `req.headers.host === undefined` → **403** |
| Absolute-form request line (`POST http://evil.test/sessions HTTP/1.1`) with a loopback `Host` | Host header is still what's checked → passes host check, then needs the token → **401** |
| Timing attack on the token | `tokensMatch` SHA-256s both sides then `timingSafeEqual`s two fixed-length 32-byte digests — no length-mismatch throw, no early exit |
| Reaching it at all in a normal production install | `COMPANION_DAEMON_HTTP` unset → `app.listen` never called, port never bound |

The port for the `Host` check is read from `req.socket.localPort` rather than threaded in
from config, which is the right call — it cannot drift out of sync with the real listener.
Test coverage is unusually good here (case-different Host, trailing-dot Host, Host with
no port, `[::1]`, `localhost`, attacker host on the correct port).

**However, this task introduced regression I3 (below).**

### Finding 3 — pairing code brute force: **closed.**

Entropy: `generatePairingCode()` draws 8 chars from a 32-symbol Crockford alphabet via
`randomAlphabetIndex`, which uses rejection sampling against `Math.floor(256/32)*32`.
40 bits, unbiased. The rejection branch is dead for a 32-symbol alphabet (256 % 32 === 0)
but the tests exercise the function at alphabet sizes that don't divide 256, with an
injected deterministic byte source — that is the correct way to test it.

Rate: `/pairing/claim` requires an authenticated *device token*, so an attacker must
first create a Clerk account and register a browser device. Per account they then face:
in-memory `claimLimiter` 10/5min keyed by `device.userId`, **and** the new persistent
`store.isClaimRateLimited` at `CLAIM_FAILURE_LIMIT=10` per 15 min — checked *before* the
code is parsed or looked up, so the 429 leaks nothing about the submitted code. That is
~10 guesses / 15 min / account against a 2^40 keyspace with codes living 5 minutes.
Infeasible by many orders of magnitude even with unlimited account creation.

Two design details I specifically checked and found correct:

- **Own-account lockout carve-out is right.** Both stores skip incrementing
  `failedAttempts` when `pairing.userId === userId`, so a legitimate user double-tapping
  their own claim in the ~2s window before the daemon's poll redeems it cannot brick
  their own pairing.
- **No victim-lockout primitive.** `recordFailedClaim` is keyed by the *guessing*
  account, never the victim's. `MAX_PAIRING_CODE_ATTEMPTS` is keyed by code, and burning
  a victim's code requires already knowing it. There is no way to lock out a stranger.
- **Non-enumeration preserved.** A cap-locked code returns `'expired'` from both stores
  and from `pollPairingCode` — indistinguishable from TTL expiry, no new status.

Note an unremarked consequence: an account that *already has a paired daemon* gets
`daemon_exists` from `PairingService.claimPairingCode` before the store is touched at
all, so such an account cannot guess codes and cannot accrue failures. That is a
closing, not an opening.

The known-deferred `recordFailedClaim` lost-update race is exactly as described — the
worst case is the limiter tripping slightly late for one abusive account. Not worse than
adjudicated.

### Finding 4 — `trust proxy`: **partially closed.** See I1.

`resolveTrustProxyHops` does throw in production when the variable is absent, with a good
message, at module load before any DB connection. But the guard is defeated by three
realistic operator paths, one of which the branch itself ships. Details in I1.

### Finding 5 — push endpoint SSRF: **closed for new subscriptions, NOT remediated for
existing ones.** See I2.

I probed the built validator directly. Correctly rejected: `http://`, `localhost`,
IPv4 literal, bracketed IPv6, `169.254.169.254`, decimal (`2130706433`) and hex
(`0x7f000001`) and short-form (`127.1`) IPv4 — the WHATWG URL parser normalizes all of
those to `127.0.0.1` before `isIpLiteral` sees them, so they're caught. The stated
suffix-boundary bypass `evil-fcm.googleapis.com.attacker.test` and the simpler
`fcm.googleapis.com.attacker.test` are both rejected. Internal single-label and
internal-domain hosts rejected. Correctly accepted: each provider host, subdomains, and
uppercase (URL lowercases the hostname).

Accepted-but-harmless: userinfo (`https://user:pass@fcm.googleapis.com/x`) and non-443
ports (`https://fcm.googleapis.com:22/x`). Neither yields an internal target, because
the host must still be a real push provider.

---

## 2. Important findings

### I1 — The `trust proxy` fail-fast is defeated by the branch's own `.env.example`, by an empty value, and by an unset `NODE_ENV`

`packages/relay/.env.example` still ships:

```
COMPANION_RELAY_TRUST_PROXY=0
```

The original finding (relay C2) explicitly called out that "`0` is also the value in
`.env.example`". That line is unchanged. An operator who does the documented thing —
`cp packages/relay/.env.example packages/relay/.env` — and deploys behind a load
balancer gets **exactly the original vulnerability**, and because the variable *is* set,
`resolveTrustProxyHops` is satisfied and the relay starts silently. The only feedback is
one `console.warn` on the first request carrying `X-Forwarded-For`, which requires
traffic and is easy to miss in a log stream.

Two further bypasses, verified by executing `dist/trust-proxy.js`:

```
undefined, production  -> THROWS      (correct)
"",        production  -> returns 0   (silent — Number('') === 0)
" ",       production  -> returns 0   (silent)
```

Many PaaS UIs and `KEY=` in a compose/env file produce an empty string rather than an
absent variable. And the whole guard hangs on `NODE_ENV === 'production'`, which is
itself an env var an operator must remember to set; if the platform doesn't set it, the
relay silently defaults to 0 hops in production with no error at all.

Net effect: the collapse-every-client-into-one-rate-limit-bucket bug (≈80 unauthenticated
requests lock out every user's pairing and browser registration, repeatable) survives all
three of the most likely deployment paths.

**Fix:** comment out the value in `.env.example` (`# COMPANION_RELAY_TRUST_PROXY=` with
the explanatory comment retained), and treat a blank/whitespace-only value as unset in
`resolveTrustProxyHops` so it takes the throw path. Optionally also fail fast if
`NODE_ENV` is unset while `DATABASE_URL` points at a non-local host, or simply document
`NODE_ENV=production` as a required deploy variable.

### I2 — The push SSRF fix is ingress-only; endpoints already stored are still POSTed to, now carrying session content

`PushSubscriptionPayload` validates on write (`POST /devices/push-subscription`). The
send path does not re-validate:

`packages/relay/src/hub.ts`, `notifyPush()` reads `device.pushSubscription` straight from
the database and hands it to `WebPushSender.send()`, which calls
`webpush.sendNotification({ endpoint: subscription.endpoint, ... })`. There is no
validation between the DB read and the outbound POST, and neither migration 0005 nor
0006 nulls out or filters non-conforming rows.

Consequence: on any database populated before this branch, every already-stored endpoint
remains a live, replayable, authenticated blind-SSRF primitive fired on every qualifying
session event — which is precisely the primitive relay I6 described. It is now *worse*
than a blind primitive for `turn_complete` events, because `lastAssistantTextOrProjectPath`
puts up to 140 characters of the assistant's actual output into the push `body`, so a
stale malicious endpoint receives session content, not just a ping.

Whether anyone has exploited this depends on whether the deployed database has real
paired devices; I could not determine that read-only. But "the fix does not remediate
pre-existing state" is a real gap regardless, and nothing in the branch, the README, or
the task reports flags a required operator step.

**Fix (either, ideally both):**
1. A one-line data migration nulling non-conforming subscriptions, e.g.
   `UPDATE devices SET push_subscription = NULL WHERE push_subscription IS NOT NULL AND push_subscription->>'endpoint' !~ '<allowed-host-pattern>';`
2. Cheaper and self-healing: re-parse with `PushSubscriptionPayload.safeParse` in
   `notifyPush` before calling `pushSender.send`, and clear the subscription when it
   fails. Roughly four lines, and it makes the control robust against any future path
   that writes the column.

### I3 — Second instance of the event-loop exit-0 regression: the daemon exits 0 under its *default* configuration

The already-fixed regression was "relay unreachable → nothing holds the loop open →
exit 0". The same shape survives one branch over. In `packages/daemon/src/main.ts`,
`main()` now guards *both* long-lived things:

```ts
if (HTTP_ENABLED) { ... app.listen(...) } else { console.log('...disabled...') }
if (RELAY_URL)   { void connectWithRetry(...) }
```

With neither set — which is the default for a fresh checkout following the daemon
README's `npm run build && npm start` — nothing keeps the event loop alive. Confirmed
empirically:

```
$ env -u COMPANION_RELAY_URL -u COMPANION_DAEMON_HTTP node dist/main.js
Local HTTP control surface disabled (set COMPANION_DAEMON_HTTP=1 to enable it for local development).
EXIT CODE: 0
```

Before this branch, `npm start` bound the HTTP surface unconditionally and stayed up.
Now it prints one informational line and terminates with a success code. A process
supervisor reads exit 0 as an intentional clean shutdown and will not restart or alert;
a developer sees the daemon "not work" with no error. Not a security hole on its own —
it fails safe — but it is the same silent-lifetime class the branch was asked to watch
for, and no test covers it (`main.test.ts` tests `isHttpSurfaceEnabled` and
`connectWithRetry` in isolation, never `main()`).

**Fix:** in the `else` branch of both guards — i.e. when neither channel is configured —
log an actionable error and `process.exit(1)`, or refuse to start with a message naming
both variables. Add a test.

### I4 — The destructive-test guard is a byte-comparison, so two equivalent URLs for the same database still pass

Both guards are `TEST_DATABASE_URL === process.env.DATABASE_URL`. Any of these operator
mistakes produce two different strings pointing at the *same* database, pass the guard,
and let `TRUNCATE TABLE users, devices, pairing_codes, claim_failures, sessions, session_events RESTART IDENTITY CASCADE`
run against it:

- Neon hands out both a pooled host (`ep-xxx-pooler.<region>.aws.neon.tech`) and a direct
  host (`ep-xxx.<region>.aws.neon.tech`) for the same database. `DATABASE_URL` on one,
  `COMPANION_TEST_DATABASE_URL` on the other → guard passes, real data wiped.
- Differing query parameters (`?sslmode=require` vs `?sslmode=require&channel_binding=require`).
- A trailing slash, a different role/password for the same database, or differing case in
  the host.

This is not hypothetical for this project specifically: the two configured URLs already
share a host and differ only in the database path, which shows the operator is composing
these strings by hand from the same Neon project rather than copying a branch's
connection string wholesale.

**Fix:** parse both with `new URL()` and compare `hostname`-with-`-pooler`-stripped plus
`pathname` (the database name), not the raw strings. Keep the byte-comparison as an
additional cheap check.

---

## 3. Minor findings and defence-in-depth gaps

**M1 — `COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST` is read before `.env` is loaded, and is
missing from `.env.example`.** `packages/protocol/src/push.ts` evaluates
`parseExtraAllowedHosts(process.env.COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST)` at module
load. In the relay, ESM hoists all of `main.ts`'s imports — which reach
`server.js → @companion/protocol → push.js` — so that evaluation happens *before*
`process.loadEnvFile('.env')` on line 18. Setting the variable in `packages/relay/.env`
(the mechanism the README documents for every other relay variable) is therefore silently
ignored, and the README's promise that "the relay fails fast at startup if it's set but
malformed" does not hold for `.env`-supplied values. It works when set as a real process
env var, which is how production would set it. **Fails closed** (the allowlist just stays
at the five base hosts), so this is a config-correctness bug, not a security hole. The
plan also required every new env var to land in `.env.example`; this one did not.
Relatedly, the comment in `main.ts` — "None of the imports above read env vars at their
own module-load time, so it doesn't matter that this runs after them" — is now false and
is exactly the kind of stale invariant that will mislead the next change.

**M2 — Import-time throw in a shared package.** A malformed allowlist now throws during
module initialization of `@companion/protocol`, which the daemon and web app also import.
I checked whether this breaks the browser build: it does not — Vite substitutes
`process.env` with `{}` (visible as `var U2={}` in the shipped
`packages/web/dist/assets/index-CWnpNS8w.js`, immediately before the allowlist array), so
the call returns `[]` inertly. Worth knowing that the safety of a relay-shaped env var in
a shared package currently depends on a bundler substitution.

**M3 — `schema.test.ts` still migrates and writes to `DATABASE_URL`.** Self-flagged and
deferred in task-1-report.md, and I agree with the deferral, but stating it plainly: running
`npm test` still executes `runMigrations()` (DDL) and unconditional `INSERT`s against
whatever `DATABASE_URL` points at, with no cleanup — so rows accumulate in the real dev/prod
database and its schema is mutated by the test suite. The branch's headline "tests can no
longer touch the production database" is true only of the destructive suite.

**M4 — README's "Rate limits" section contradicts the code on the security-critical
control.** `packages/relay/README.md` documents only the per-code `failedAttempts`
lockout and calls it "the actual bound on a sustained online guessing attack".
`store.ts` says the opposite, correctly and at length: the per-code counter explicitly
does *not* bound blind guessing, because a wrong guess matches no row. The per-account
`claim_failures` table — which is what actually bounds it — is not documented in the
README at all. An operator reasoning about this control from the README would reach the
wrong conclusion.

**M5 — `connectWithRetry` retries permanently-failing pairing forever.** A daemon whose
pairing code expires unclaimed now throws, backs off, and requests a *new* pairing code,
indefinitely (up to one every 30s). Consequences: a rolling set of live 40-bit codes
instead of one, unbounded terminal output of new codes, and self-inflicted 429s against
`/pairing/request-code`'s 20-per-5-min IP limiter. Harmless at 40 bits, but a
never-give-up retry on a *permanent* error is worth a cap or a distinction between
retryable and terminal failures.

**M6 — Legitimate users can consume their own durable claim budget.** A late or mistyped
code produces `not_found`/`expired`, which counts toward `CLAIM_FAILURE_LIMIT`. Ten of
those in 15 minutes locks a real user out of pairing with a 429 that does not explain
itself. Combined with M5 (codes rotating underneath the human), mistiming is more likely
than the comment in `store.ts` assumes.

**M7 — Neither failure counter is ever reaped.** `InMemoryStore.claimFailures` (a `Map`)
and the `claim_failures` table both grow one row per account that has ever failed a
claim, with no sweep — unlike `pairing_codes`, which has reap-on-write in
`createPairingCode`. Small, but unbounded, and cheap to attack given public signup.
The pre-existing `RateLimiter.hits` map has the same unbounded shape keyed by IP.

**M8 — Local token file hygiene.** `local-auth.ts` writes with `{ mode: 0o600 }`, which
Node applies only on *creation* — an existing file with looser permissions keeps them.
`mkdir(dirname, { recursive: true })` creates `~/.companion` with the default umask
(typically 0755), so the directory is world-readable even though the file is not. On
Windows the mode is ignored entirely (documented as "0600 on POSIX"). Separately, the
token is printed to the daemon's stdout on every start, so any log capture
(systemd journal, pm2, a CI log) durably records a credential to a full-tool-access
control surface. All three are acceptable for a dev-only, opt-in surface; none is
acceptable if this surface is ever promoted.

**M9 — Migration concurrency.** `runMigrations` uses drizzle's `node-postgres` migrator
with no advisory lock, and `0006_sour_ezekiel_stane.sql` is a bare `CREATE TABLE`
(no `IF NOT EXISTS`). Two relay instances booting simultaneously on a rolling deploy can
race; the loser crashes at startup with "relation already exists". Pre-existing
architecture, but 0005/0006 are the first migrations to meet a populated production
database. Deploy single-instance-first, or wrap `runMigrations` in
`pg_advisory_lock`.

Also noted, no action needed: `formatPairingCodeForDisplay` in `packages/relay/src/store.ts`
is dead code (used only by its own test — the daemon has its own copy in `device-auth.ts`,
which is correct since it can't import from the relay). `/pairing/poll` remains
unauthenticated and unrate-limited, but its input is a 122-bit UUID; pre-existing.

---

## 4. Cross-task interference

I looked specifically for one hardening change weakening another. **None found.** Detail:

- **Daemon auth vs the relay path.** Fully independent. `COMPANION_DAEMON_HTTP` gates
  only the `createHttpServer`/`listen` block; the `RELAY_URL` block is untouched and the
  relay control channel works identically with the HTTP surface off. The two tokens are
  distinct secrets in distinct files (`daemon-device.json` vs
  `daemon-local-http.json`), neither is accepted by the other surface, and
  `getOrCreateLocalToken` never contacts the network. The *only* coupling is the
  lifetime one (I3), where removing the unconditional `listen` changed process lifetime
  for the no-relay case as well as the relay-failure case.
- **Pairing entropy vs the daemon's retry loop.** The longer code changed the daemon's
  display path (`formatPairingCodeForDisplay`) and the web input constraints
  (`maxLength` 6→12, `inputMode` numeric→text, `autoCapitalize="characters"`) and the
  wire schema (`ClaimPairingRequest.code` gained `.max(32)`). All consistent. The relay
  normalizes (uppercase, strip `[\s-]`) before matching, so a 32-char all-hyphen payload
  normalizes to `''` and misses cleanly. No path accepts an unnormalized code.
- **Push allowlist vs the relay's env handling.** One genuine interaction, M1 above: the
  allowlist reads its variable at protocol-import time, which is before the relay loads
  `.env`. This is the only env-var precedence problem I found. The other new variables
  (`COMPANION_TEST_DATABASE_URL`, `COMPANION_DAEMON_HTTP`,
  `COMPANION_LOCAL_HTTP_TOKEN_PATH`) are read in the right packages at the right times
  and do not collide with existing names.
- **New DB objects vs existing queries.** `claim_failures` is a new isolated table with
  no FK; `pairing_codes.failed_attempts` is additive with a default, so pre-existing
  INSERTs that omit it still work. Old relay code (mid-rolling-deploy) never references
  either. No existing query changes shape.
- **Test isolation vs everything else.** `postgres-store.test.ts` moving to a different
  connection string does not affect any non-test path. The `TRUNCATE` list correctly
  gained `claim_failures`, so the new table is cleaned between cases and won't leak
  lockout state across tests.

---

## 5. Regressions

Actively hunted for "behaviour removed or gated that something else depended on".

- **I3 (found).** The only one of the flagged shape.
- **`createHttpServer` signature change.** Now requires `options.token`. Grepped the
  whole repo: the only callers are `main.ts` and `http-server.test.ts`, both updated.
  The new export is additive in `index.ts`. No third caller, no script, no doc outside
  historical plan files references the port unauthenticated.
- **Tests weakened to accommodate auth?** No. I diffed every removed assertion. One
  `expect(res.status).toBe(400)` disappears, but it is replaced in-place by a stronger
  401 case, and `http-server.test.ts` still has four independent 400 assertions for
  invalid bodies plus a new one proving the auth middleware runs *before* body parsing.
  Test count went up, not down.
- **Suites still green.** protocol 42/42, daemon 94 passed + 1 skipped, web 189/189.
  Relay not run per instruction.
- **`app.set('trust proxy', ...)` behaviour unchanged at runtime** — the only change is
  where the value comes from and the new once-per-process warning middleware, which is
  registered after `cors`/`express.json` and calls `next()` unconditionally.
- **Push fixture churn.** All `push.example.com` fixtures were replaced repo-wide; zero
  remain. No test was made to pass by adding `example.com` to the allowlist.

---

## 6. Operational safety

**Migrations against a populated production database: safe.**
- `0005`: `ALTER TABLE "pairing_codes" ADD COLUMN "failed_attempts" integer DEFAULT 0 NOT NULL`.
  On PostgreSQL 11+ a non-volatile default takes the metadata-only fast path — no table
  rewrite, only a brief `ACCESS EXCLUSIVE` lock on a table that is swept of expired rows
  on every write and is tiny by construction.
- `0006`: `CREATE TABLE "claim_failures"` — new table, no FK, no lock on anything else.
- Both are additive and **rolling-deploy compatible**: old code doesn't reference the new
  column or table, and new code only runs after `runMigrations` completes in its own
  process (`main.ts` awaits it before `listen`). Journal and snapshots are consistent
  (entries 5 and 6 present, tags match filenames).
- Caveat M9 (no advisory lock, no `IF NOT EXISTS`) for simultaneous multi-instance boot.

**Manual operator steps that silently degrade security if forgotten:**

| Step | Failure mode |
|---|---|
| Set `COMPANION_RELAY_TRUST_PROXY` to the real hop count in production | **Silent** — `.env.example` ships `0`, an empty value passes, and an unset `NODE_ENV` skips the check entirely (I1) |
| Purge/re-validate push subscriptions stored before this branch | **Silent** — nothing checks, nothing warns, no documented step (I2) |
| Set `NODE_ENV=production` in the deployment | **Silent** — disables the trust-proxy guard entirely (I1) |
| Provision `COMPANION_TEST_DATABASE_URL` | Loud and correct — the suite throws before connecting |
| Enable `COMPANION_DAEMON_HTTP` | Fails safe (off) |

Two of the five require an operator to remember something with no feedback if they
don't. That is the weakest part of the branch's operational story.

**Secrets hygiene: clean.** Scanned the full diff for connection strings with embedded
credentials, `sk_live`/`sk_test` values, private-key blocks, AWS keys, GitHub tokens, and
long VAPID-shaped values — nothing. The only `.env*` file in the diff is
`.env.example`, which contains placeholders only (`<user>:<password>@<host>`,
`sk_test_...`). `.env`, `dist/`, and `.superpowers/` are all in `.gitignore`; the real
`packages/relay/.env` exists on disk and is untracked. I compared the two configured
database URLs only by SHA-256 prefix and parsed components, never printing values. Working
tree is clean and I made no changes.

---

## 7. Recommended fixes before merge

Blocking-ish (both small):
1. **I1** — comment out `COMPANION_RELAY_TRUST_PROXY=0` in `.env.example`; treat blank as
   unset in `resolveTrustProxyHops`; document `NODE_ENV=production` as required.
2. **I2** — re-validate `device.pushSubscription` in `hub.notifyPush` before sending
   (and clear it on failure), and/or ship a backfill statement.

Cheap and worth doing in the same pass:
3. **I3** — exit non-zero with an actionable message when neither control channel is
   configured; add a test.
4. **I4** — compare host + database name, not raw strings, in the test-DB guard.
5. **M1** — add `COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST` to `.env.example`, and either
   move the parse behind a function called after `loadEnvFile` or correct the now-false
   comment in `main.ts` and the README's fail-fast claim.
6. **M4** — fix the README's "Rate limits" section to describe `claim_failures` as the
   actual guessing bound.

Everything else on the Minor list is fine to carry.
