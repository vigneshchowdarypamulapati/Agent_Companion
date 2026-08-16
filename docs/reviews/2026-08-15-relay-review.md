# `packages/relay` — Production-readiness & security review

Reviewed at commit state of 2026-08-15. All 17 source files under `packages/relay/src/`, both
`drizzle.config.ts` and all 5 migrations were read in full, plus `packages/protocol/src/*.ts` for
wire-schema context. `npm run test -w @companion/relay` was run against the live Neon database:
**10 files / 201 tests passing**.

---

## Strengths

These are real and worth keeping:

- **Cross-user isolation actually holds.** I traced all 13 REST routes and both WebSocket message
  paths. No path anywhere trusts a client-supplied `userId`, `deviceId`, or `deviceType`: the
  identity always comes from `PairingService.verifyToken()` → the `devices` row
  (`server.ts:35-41`, `server.ts:380-393`). Every session-scoped query re-checks
  `session.userId !== device.userId` (`server.ts:215`, `232`, `store.dismissSession`), and
  `ConnectionHub.routeFromDaemon` uses the *stricter* `session.daemonDeviceId !==
  connection.deviceId` (`hub.ts:193`) rather than a userId match. `dispatchLocal` re-checks
  `connection.userId === envelope.userId` on both fan-out branches (`hub.ts:280`, `288`).
  **I found no cross-user read or write.**
- **No SQL injection.** The one raw `sql` template (`postgres-store.ts:205`,
  `` sql`${sessionEvents.event}->>'type' = ${type}` ``) interpolates a Drizzle column object and a
  bound `Param` — verified against Drizzle's `sql` builder; it is parameterized, not concatenated.
  Every other query is Drizzle query-builder. No string interpolation reaches Postgres anywhere.
- **The 404-not-403 discipline is correct and consistent** (`server.ts:213-217`, `251-256`), so
  session ids cannot be enumerated by a non-owner.
- **The pairing race conditions are genuinely closed.** `claimPairingCode` and `redeemPairingCode`
  are each a *single conditional UPDATE ... RETURNING* whose WHERE clause is the whole guard
  (`postgres-store.ts:99-105`, `124-136`), so concurrent claims/redemptions cannot both win. The
  one-daemon-per-account rule is enforced three times — at claim, again at redeem
  (`pairing.ts:48-51`), and as a partial unique index in the DB (`db/schema.ts:66`). That third
  layer is exactly the right instinct.
- **The error handler was fixed correctly.** `server.ts:347-359` returns a bare
  `500 {"error":"Internal server error"}` for anything non-Zod and logs the detail server-side; the
  code comment shows the author already caught and removed the SQL/param leak. Good.
- **CORS fails closed** (explicit origin allowlist, no `credentials`, no wildcard) and env-var
  validation fails fast at boot for `DATABASE_URL`, `CLERK_SECRET_KEY`, `COMPANION_RELAY_TRUST_PROXY`
  and `COMPANION_RELAY_CORS_ORIGIN` (`main.ts:25-69`).
- **`unregister` is identity-based, not deviceId-based** (`hub.ts:95-105`), so a stale socket's late
  `close` cannot evict a live reconnect — a subtle bug that is usually present and is tested here.
- **`notifyPush` is deliberately called from `routeFromDaemon`, not `dispatchLocal`** (`hub.ts:229-239`),
  which is the correct choice for a future multi-instance deployment.
- **`Store` is a port with a shared contract-test suite** run against both implementations
  (`store-contract-tests.ts`, 462 lines). Behavioral parity is enforced, not assumed.
- **The README is unusually honest and accurate** — it documents the trust-proxy hazard, the
  in-memory PubSub scaling limit, and the destructive-migration caveat. Everything it claims about
  route behavior matched the code.

---

## Critical

### C1. A 6-digit pairing code is the only thing standing between an attacker and code execution on a victim's dev machine

**`server.ts:96` / `server.ts:127` / `postgres-store.ts:78` / `pairing.ts:27-31`**

The pairing code is `randomInt(0, 1_000_000)` — 10^6 values, **≈19.9 bits of entropy** — valid for
5 minutes, and a wrong guess has *no consequence at all*: the code is not invalidated, no counter is
attached to it, and nothing is logged.

**Exact attack sequence:**
1. Attacker signs up via Clerk (public signup) and `POST /devices/register-browser` → device token.
   Their account has no daemon, so the `daemon_exists` gate at `pairing.ts:28` does not apply.
2. Attacker loops `POST /pairing/claim {"code":"000000"}` … `{"code":"999999"}` with that token.
3. On a hit, `postgres-store.ts:99-105` sets `pairing_codes.user_id = attackerUserId` on a code the
   **victim's daemon** created.
4. The victim's daemon, still polling `POST /pairing/poll {deviceCode}`, sees `pairing.userId` set,
   redeems, and is minted a daemon token bound to **the attacker's user id** (`pairing.ts:54-59`).
5. The attacker's browser now opens `/ws?token=…` and sends
   `{kind:'command', command:{type:'inject_prompt', sessionId, text:"…"}}`. `routeFromBrowser` passes
   (`session.userId === connection.userId` — the session *is* the attacker's now), and the victim's
   daemon executes it. That is arbitrary prompt injection into a live Claude Code session on the
   victim's machine, i.e. effective code execution on their dev box.

The victim sees only "pairing succeeded."

**What the limiter actually buys:** `claimLimiter = new RateLimiter(10, FIVE_MINUTES_MS)` keyed by
`device.userId` — 10 guesses per account per code lifetime, so ~1e-5 per account per window. That is
a real cost, but it is the *only* defence, and it is weaker than it looks:
- The limiter is **in-process and in-memory** (`rate-limiter.ts:11`). Every relay restart or deploy
  **resets every counter to zero**. An attacker who paces guesses across deploys pays nothing.
- With more than one relay instance the budget multiplies by the instance count.
- Accounts are free and scriptable; each additionally yields 10 registrations/hour.
- The attacker does not need to target a *specific* victim — any live code from any user is a win,
  and the attack can run continuously for months.

**Fix (one line, and it eliminates the whole class):** make the code 8+ characters from an
unambiguous base-32 alphabet (Crockford: no I/L/O/U) — `~40 bits`, still typeable, and brute force
becomes arithmetically impossible. Additionally: (a) hard-delete a pairing code after N failed claim
attempts *against that code*, tracked in the `pairing_codes` row so it survives restarts, and (b) log
failed claims so the attempt is at least visible.

### C2. With the default `trust proxy: 0`, two IP-keyed limiters collapse into one global bucket — ~80 HTTP requests lock every user out of pairing and browser registration

**`server.ts:102`, `server.ts:109`, `server.ts:165`; `main.ts:41` (`let trustProxyHops = 0`); `.env.example:4` (`COMPANION_RELAY_TRUST_PROXY=0`)**

`requestCodeLimiter` (20 / 5 min) and `registerBrowserPreAuthLimiter` (60 / 5 min) key on `req.ip`.
Behind any PaaS load balancer — which is the stated deployment model ("hosted relay", Neon) — with
`trust proxy` left at its default `0`, `req.ip` is **the load balancer's address for every request in
the world**. Both limiters then share a single global bucket.

**Attack:** an unauthenticated attacker sends 20 `POST /pairing/request-code` and 60
`POST /devices/register-browser` requests (garbage bodies are fine — the limiter runs *before* body
parsing at `:109` and *before* auth at `:165`). For the next 5 minutes:
- **No daemon anywhere can request a pairing code.**
- **No browser anywhere can register** — including every legitimate first-time sign-in.

Repeat every 5 minutes with a trivial script and the product is permanently unusable for all users, at
a cost of ~16 requests/minute from a single IP. This is not a theoretical misconfiguration: the
default value in code, in `.env.example`, and in the fail-fast validator all point at `0`, and nothing
warns at startup.

**Fixes, all three:**
1. `main.ts` should **refuse to start (or log a loud startup warning) when `NODE_ENV=production` and
   `COMPANION_RELAY_TRUST_PROXY` is unset**, rather than silently defaulting to the value that breaks
   the limiters.
2. Redesign the failure mode: a limiter that cannot identify the client should **fail open per-key and
   trip a separate global circuit-breaker**, never silently become a global lockout. Concretely, the
   `registerBrowserPreAuthLimiter` should not be able to block registration outright — make it a
   delay/challenge, or drop it and rely solely on the Clerk-identity limiter at `:180`, which is
   already described in the code comment as "the real control."
3. Move the limiters to a shared store (Redis) alongside the PubSub work — see I4.

---

## Important

### I1. WebSocket has no payload limit, no connection cap, and no keepalive

**`server.ts:362` — `new WebSocketServer({ server: httpServer, path: '/ws' })`**

Three separate omissions, all on the internet-facing socket:

- **No `maxPayload`.** `ws` defaults to **100 MiB per frame**. Any signed-up user can self-pair a
  daemon (request-code → claim with their own account → poll, all free) and then send
  `{kind:'event', event:{type:'assistant_text', text:"<100 MB of 'a'>"}}`. `raw.toString()` +
  `JSON.parse` allocates it, Zod (`events.ts:22` — `z.string()`, no `.max()`) accepts it, and
  `appendSessionEvent` writes it to a `jsonb` column. A handful of concurrent frames OOMs the process;
  a slow loop fills the Neon database at the author's expense. **Fix:** `maxPayload: 256 * 1024`, plus
  `.max()` bounds on `text`, `message`, `projectPath`, `toolName`, `deviceName` in
  `packages/protocol`.
- **No per-device or per-user connection cap.** `hub.register` (`hub.ts:81-93`) stores connections in
  an unbounded `Set` per deviceId. One token can open thousands of sockets; each one is also a fan-out
  target in `dispatchLocal`, so event delivery cost is attacker-controlled. **Fix:** cap connections
  per device (e.g. 5) and reject the excess with 4429.
- **No ping/pong heartbeat.** `ws` does not ping automatically. A phone that drops off the network
  never emits `close`, so the `Connection` leaks in `hub.connections` forever *and* — worse — for a
  daemon, `unregister` never runs, so `scheduleDaemonStop` never fires and the user's sessions stay
  "running" indefinitely with no way to dismiss them (`server.ts:257` requires `status === 'stopped'`).
  **Fix:** the standard `setInterval` ping / `isAlive` terminate loop.

### I2. Graceful shutdown hangs forever whenever a WebSocket client is connected

**`main.ts:107-115`**

```js
await new Promise<void>((resolve) => httpServer.close(() => resolve()));
```

`http.Server.close()` stops accepting new connections and then **waits for all existing sockets to
end**, including upgraded WebSocket sockets. Daemon and browser sockets are long-lived by design and
will never close on their own, so the callback never fires, `pool.end()` never runs, and
`process.exit(0)` is never reached. Every deploy therefore ends in a platform SIGKILL after the
grace window (typically 30 s), with in-flight `appendSessionEvent` transactions cut mid-flight and
clients getting an abrupt RST instead of a clean 1001.

Also missing: `wss.close()`, `ConnectionHub`'s `pendingDaemonStops` timers are never cleared (they
keep the loop alive up to 30 s on their own), `shutdown` has no re-entrancy guard against
SIGTERM-then-SIGINT, and `void shutdown(...)` means a `pool.end()` rejection becomes an unhandled
rejection.

**Fix:** in `shutdown` — stop the WS server, iterate live sockets sending close code `1001`, call
`httpServer.closeAllConnections()` (Node 18.2+), clear the hub's timers, and wrap the whole thing in
a `Promise.race` with a ~10 s hard-exit timer.

### I3. Migrations run at every boot with no advisory lock

**`main.ts:88` (`await runMigrations(db)`) / `db/migrate.ts:10`**

I read Drizzle's implementation (`node_modules/drizzle-orm/pg-core/dialect.cjs:46-73`): it does
`CREATE SCHEMA IF NOT EXISTS` → `CREATE TABLE IF NOT EXISTS __drizzle_migrations` → **`SELECT` the
last applied migration** → then a transaction applying anything newer. There is **no
`pg_advisory_lock`**. Two instances booting concurrently — which is exactly what a rolling deploy or a
2-replica setup does — both read the same "last applied" row and both try to apply the same DDL. One
commits; the other fails on `ALTER TABLE`/`CREATE INDEX` already-exists and **crashes at boot**, before
`listen()`. On a PaaS that means a crash-loop on the new revision.

**Fix:** wrap `runMigrations` in `SELECT pg_advisory_lock(<constant>)` / `pg_advisory_unlock`, or
(better for a hosted service) move migrations out of the app process into a release/pre-deploy step
and have `main.ts` merely *verify* the schema version and refuse to start if it's behind.

### I4. `RateLimiter` never evicts keys — unbounded memory growth

**`rate-limiter.ts:11-30`**

`attempt()` filters the timestamp array for a key but **always writes the key back**
(`this.hits.set(key, recent)` on both branches, lines 24 and 28). No key is ever deleted, even when
its array is empty. Four limiter instances each accumulate one permanent `Map` entry per distinct
IP / userId / Clerk id ever seen. On the pre-auth IP limiter that is attacker-controlled: from an IPv6
range, every request mints a permanently-retained entry. Memory grows monotonically until restart.

**Fix:** delete the key when `recent.length === 0`, and add a periodic sweep (or switch to an LRU /
`rate-limiter-flexible` with a Redis backend, which C2 needs anyway).

### I5. `POST /pairing/poll` is unauthenticated and completely unthrottled

**`server.ts:153-160`**

The only route with neither authentication nor a rate limiter. Each call runs
`getPairingCodeByDeviceCode` and possibly `getDaemonDeviceForUser` + `redeemPairingCode` — 1-3 round
trips against a pool of **`max: 10`** (`db/client.ts:8`). An unauthenticated flood here saturates the
pool and starves every authenticated route, including the WebSocket handshake's
`getDeviceByTokenHash`.

The `deviceCode` itself is a `randomUUID()` (122 bits) so it is *not* brute-forceable — I checked, and
that part is fine. The issue is purely availability.

**Fix:** add an IP-keyed limiter here (poll is a slow loop by design — 1 per 2 s is generous), and
consider an exponential backoff hint in the `pending` response.

### I6. SSRF / outbound-request amplification via the push subscription endpoint

**`packages/protocol/src/push.ts:5-16` → `server.ts:328` → `web-push-sender.ts:18`**

`PushSubscriptionPayload.endpoint` is validated only as "a URL whose protocol is `https:`". There is
no host allowlist. Any authenticated device can store
`https://10.0.0.5:8443/admin`, `https://metadata.internal/…`, or `https://victim.example.com/expensive`
and the relay will `POST` to it — from inside the hosting provider's network — every time a
qualifying event fires (`hub.ts:254`).

This is **blind** SSRF (the response is discarded, only `statusCode` 404/410 is inspected, and the body
is ECIES-encrypted to the attacker's own keys), so it is not a direct data-exfiltration primitive.
What the attacker gains concretely: (a) probing/port-scanning internal https services from a trusted
network position, with a 404/410-vs-other oracle in the `gone` handling, and (b) using the relay as an
authenticated request amplifier — one daemon event fans out one POST per subscribed device, and the
attacker controls both the trigger rate and the number of subscriptions.

**Fix:** allowlist the known push services by hostname suffix
(`*.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, `*.push.apple.com`) — this
is what every production Web Push implementation does — and reject private/loopback/link-local
resolution as a second layer.

### I7. `GET /sessions/:id/events` is unbounded, and `session_events` is never pruned

**`server.ts:236-238`, `postgres-store.ts:189-196`, `db/schema.ts:94-101`**

`getSessionEvents(sessionId, sinceSeq)` has no `LIMIT`. A long Claude session accumulates thousands of
events (every `assistant_text`, `tool_use`, `tool_result`); `?since=0` — or simply a first page load
after a long session — materialises the entire history in Node's heap, serialises it to JSON, and
ships it. This is owner-only so it isn't a cross-user issue, but it is a self-inflicted OOM and a
trivial "expensive request" amplifier for any authenticated user.

Separately, **nothing ever deletes from `session_events` or `sessions`**. Dismissal only sets a flag.
On a hosted multi-user service billed per GB (Neon), this grows forever with no ceiling and no
retention policy.

**Fix:** add `.limit(n)` (500 default, capped) with a `nextSeq` cursor in the response, validate
`since` as a non-negative integer, and add a retention job (e.g. drop events for sessions stopped >30
days ago).

### I8. Observability is close to zero — a production incident would be undebuggable

Currently the relay logs exactly three things: the listen line, pool errors (`db/client.ts:13`), and
`Unhandled relay error` (`server.ts:357`). Everything else is deliberately silent:

- `hub.ts:160-163` — `catch { }` swallowing every failure of the orphaned-session cleanup, with no
  log. If this path breaks, users' sessions silently stick at "running" forever and there is no
  signal at all.
- `hub.ts:263-265` and `hub.ts:258-260` — every push failure swallowed silently. "Notifications
  stopped working" would be uninvestigable.
- `server.ts:365` `wss.on('error', () => {})` and `server.ts:370` `ws.on('error', () => {})` — correct
  to attach a handler (an unhandled `error` kills the process), but they should **log**, not discard.
- `server.ts:418-421` — a store failure during WS setup closes with 1011 and logs nothing.
- No request logging, no auth-failure logging, no rate-limit-trip logging (so C1's brute force and
  C2's DoS are both completely invisible), no connect/disconnect logging, and **no `/health` or
  `/readyz` endpoint** for the platform's health check.

**Fix:** a structured logger (pino) with a request id; log every 401/429 with route + key; log
WS connect/disconnect with deviceId/userId; keep every `catch` but add `logger.error` inside; add
`GET /health` that pings the DB.

### I9. Device tokens are eternal, unrotatable, and travel in the WebSocket URL

**`pairing.ts:4-9`, `pairing.ts:71-78`; `server.ts:374-384`**

The token itself is fine — `randomBytes(32)` hex = 256 bits, SHA-256'd before storage, unique index on
`token_hash`. On the constant-time question: the comparison is a Postgres index lookup on a
SHA-256 digest, so a timing side-channel yields nothing exploitable (an attacker would need a preimage,
not a prefix). That is genuinely not a problem here.

What *is* a problem:
- **No expiry, no rotation, no `lastUsedAt`.** A token minted once is valid forever.
- **No way to revoke any device but the caller's own.** `POST /devices/unpair` (`server.ts:303`)
  always targets `device.id` — the token holder. If a phone is lost or a token leaks, the legitimate
  user has **no mechanism to revoke it**; only the attacker holding it can. There is no
  Clerk-authenticated "list my devices / revoke device X" route.
- **The token is a URL query parameter** on the WS handshake (`/ws?token=…`). Load-balancer and CDN
  access logs record full request lines including the upgrade request, so device tokens end up in
  third-party log storage in cleartext.

**Fix:** (a) add a Clerk-authenticated `GET /devices` + `DELETE /devices/:id` scoped to the caller's
`userId`; (b) record `lastUsedAt` and expire idle tokens; (c) move WS auth to the
`Sec-WebSocket-Protocol` header (browsers *can* set that one — `new WebSocket(url, ['bearer', token])`)
so the secret leaves the URL.

### I10. `getLastEventOfType` scans a session's entire event history, and runs on every push-worthy event

**`postgres-store.ts:198-212`; called twice per `turn_complete` from `hub.ts:269-270`**

The filter is `event->>'type' = $1` with only `session_events_session_id_idx` available — Postgres
walks that session's rows in `seq desc` order until a match. For `assistant_text` a match is usually
near the end, so it's cheap; for a session where the type is **absent**, it is a full scan of every
event row for that session, and `lastAssistantTextOrProjectPath` does two of these on the hot path of
every `turn_complete`.

**Fix:** promote the discriminant to a real column (`event_type text not null`) with
`index on (session_id, event_type, seq desc)`, or add
`CREATE INDEX ON session_events ((event->>'type'), session_id, seq DESC)`.

---

## Minor

- **M1 — No role scoping on REST routes.** `authenticate()` (`server.ts:35`) accepts any device type,
  so a *daemon* token can call `POST /pairing/claim`, `GET /sessions/*`, `POST /devices/push-subscription`.
  Nothing exploitable today (the `daemon_exists` gate blocks the interesting one, and everything else
  is same-user data), but a compromised daemon should not be able to act as a browser. Add a
  `requireDeviceType('browser')` guard on the browser-only routes.
- **M2 — `routeFromDaemon`/`routeFromBrowser` don't assert `deviceType`.** The only enforcement is the
  `&& device.type === 'daemon'` / `'browser'` conjunction at `server.ts:399-402`. `hub.ts:170` and
  `hub.ts:211` should assert `connection.deviceType` themselves — the hub is a public export
  (`index.ts:7`) and this is the invariant that keeps browsers from forging session events.
- **M3 — Internal error text is echoed to clients.** `server.ts:349` returns Zod's full `err.message`
  (a JSON dump of issues + paths), and `server.ts:408` echoes hub error strings verbatim, including
  `"Session <id> is already owned by a different daemon"` — a session-existence oracle. Session ids
  are UUIDs so it isn't practically exploitable, but the frame should carry a code, not prose.
- **M4 — A `session_started` replay resets `dismissed` and `startedAt`.** `hub.ts:180-189` +
  `postgres-store.ts:140` (`set: session` includes every field), so re-sending `session_started`
  un-dismisses a dismissed session. Self-inflicted only; still, `set` should list only the mutable
  columns.
- **M5 — Wrong-role messages are silently dropped.** `server.ts:399-403`: a browser sending
  `kind:'event'` (or a daemon sending `kind:'command'`) falls through both branches with no error
  frame and no log. A client bug here is invisible. Send a `{kind:'error'}` frame.
- **M6 — A pairing-code PK collision returns a 500.** `pairing_codes.code` is the primary key
  (`db/schema.ts:70`), and `createPairingCode` (`postgres-store.ts:78-90`) does not retry. If a live
  unexpired code with the same 6 digits exists, the insert throws and the daemon gets
  `500 Internal server error`. Rare today; guaranteed to appear with scale. Retry a few times on
  unique-violation (and C1's larger alphabet makes it vanish).
- **M7 — Expired pairing codes are swept only inside `createPairingCode`** (`postgres-store.ts:77`).
  A relay with no pairing traffic retains expired rows indefinitely, and the sweep is an extra `DELETE`
  on the latency path of a user-facing request. Move it to a periodic job.
- **M8 — `updateSessionStatus` and `appendSessionEvent` are separate transactions**
  (`hub.ts:196-202`). A crash between them leaves status and event log divergent.
  `appendSessionEvent` already uses a transaction — fold the status update into it.
- **M9 — No security headers.** No `helmet`, so no `X-Content-Type-Options: nosniff`,
  `Referrer-Policy`, or HSTS. Low impact for a pure JSON API with no cookies, but free to add.
- **M10 — Clerk `verifyToken` is called without `authorizedParties`** (`identity-verifier.ts:44`).
  Clerk explicitly recommends setting it as a defence against tokens minted for a different frontend
  origin of the same instance. Defence-in-depth only.
- **M11 — `sslmode=require` deprecation.** The test run emitted pg's
  "SSL modes 'prefer'/'require'/'verify-ca' are treated as aliases for 'verify-full'" warning twice.
  When pg 9 lands, `require` silently drops to weaker semantics against Neon. Pin
  `sslmode=verify-full` in `.env`/`.env.example` now.
- **M12 — Pool size is hardcoded** (`db/client.ts:8`, `max: 10`) with no env override,
  no `connectionTimeoutMillis`, and no `idleTimeoutMillis` tuned for Neon's autosuspend. Make these
  configurable before the first traffic spike.
- **M13 — Re-pairing orphans in-flight sessions.** `deleteDevice` intentionally leaves
  `sessions.daemon_device_id` pointing at the deleted id (documented at `postgres-store.ts:44-48`).
  After unpair + re-pair, the new daemon has a new id, so `routeFromDaemon` rejects its events for the
  old sessions with "Unknown session". The grace-period stop covers this in practice, but the failure
  mode is a confusing WS error frame rather than a clean state.
- **M14 — `PubSub` is in-memory only** (`in-memory-pubsub.ts`, wired at `main.ts:91`). Correctly and
  prominently documented in the README and in `rate-limiter.ts`'s own comment — flagged here only to
  confirm nothing in the code *assumes* otherwise. `notifyPush`'s placement (`hub.ts:229-239`) is
  already multi-instance-correct, and `dispatchLocal`'s userId re-check is safe under fan-out. The
  things that will actually break on a second instance are: the rate limiters (C1, C2), cross-instance
  routing, and migrations (I3).

---

## Assessment — production-ready?

**Not yet, but it is close, and the gap is narrow and well-defined.** The hardest thing to get right in
software like this — cross-user isolation — is genuinely done: I traced every route and both WS paths
and could not construct a case where user A reads or affects user B's data, no client-supplied
identifier is ever trusted, there is no SQL injection, and the error handler doesn't leak internals.
The pairing state machine's concurrency is properly closed with conditional UPDATEs plus a DB-level
partial unique index, and the 201-test suite (including a shared contract suite run against both store
implementations) is real coverage, not theatre. What blocks shipping is a small set of specific
things: the pairing code is only ~20 bits and its sole defence is an in-memory counter that a deploy
resets, which converts a lucky guess into code execution on a stranger's development machine (C1);
and the IP-keyed rate limiters silently degrade into a single global bucket under the default
`trust proxy: 0`, so ~80 requests take pairing and sign-up down for everyone (C2). Behind those, the
operational layer is thin: shutdown deadlocks on any live WebSocket, migrations race on rolling
deploys, the socket accepts 100 MiB frames with no connection cap or heartbeat, and there is
effectively no logging — meaning the first real incident would be diagnosed by guesswork. Fix C1 and
C2 (both are small, surgical changes), then I1/I2/I3 and the logging in I8, and this is a solid
production service.
