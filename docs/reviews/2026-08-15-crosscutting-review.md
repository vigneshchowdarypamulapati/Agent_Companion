# Cross-cutting review — Claude Companion

Scope: the protocol contract and its consumers, the seams between daemon/relay/web,
architectural gaps, operability, and data lifecycle. Per-package code review is covered by
`daemon-review.md`, `relay-review.md`. Where a finding overlaps one of those, it is
cross-referenced rather than restated — the findings below are the ones that are only
visible when you read two or three packages together.

Verified against source at review time. `npm test -w @companion/protocol -w @companion/daemon`
passes (26 + 60 tests). Relay tests not run — they require a live `DATABASE_URL` and truncate it
(see C3).

---

### Strengths

- **The protocol package earns its keep.** `SessionEvent`/`Command` are real Zod schemas,
  parsed at *both* trust boundaries (`packages/relay/src/server.ts:398`,
  `packages/daemon/src/relay-client.ts:111`, `packages/web/src/relay-connection.ts:121`).
  Nothing crosses a socket unvalidated. That is the single highest-leverage thing this
  codebase did right.
- **Exhaustiveness is enforced by the compiler in both places it matters.**
  `command-dispatcher.ts:31-34` uses a `never` assignment; `ActivityFeed.tsx:27` uses an
  explicit `: string` return type to the same effect. Adding a `Command` or `SessionEvent`
  variant will not silently no-op in either consumer — it will fail the build.
- **The event/status/notification matrix has no gaps.** I built it (below) and the two
  duplicated status maps are *byte-identical* — `diff` of `hub.ts:24-32` against
  `use-sessions-store.ts:20-28` is empty. Every event type is described by `ActivityFeed`.
  Every omission (`tool_result`, `command_failed`) is deliberate and documented on both sides.
- **The ports are drawn in the right places.** `Store` and `PubSub` are interfaces with an
  in-memory implementation plus a shared contract-test suite (`store-contract-tests.ts`).
  Swapping `InMemoryPubSub` for Redis genuinely is a `main.ts` one-liner. The seam that will
  matter most later is the one that was designed for.
- **Seq-based reconcile is correct.** Store-assigned `seq` on every broadcast event plus
  `?since=<seq>` history gives the web client a real gap-free catch-up path, and both
  `use-sessions-store.ts` and `SessionDetail.tsx` implement the buffer-while-loading dance
  properly (including not double-notifying subscribers). This is the kind of thing that is
  usually wrong.
- **Comment quality is genuinely unusual.** Most non-obvious decisions carry a comment
  explaining the alternative that was rejected and why (e.g. `hub.ts:229-239` on why
  `notifyPush` is called from `routeFromDaemon` and not `dispatchLocal`). This review was
  fast *because* of that.

---

### Critical (blocks real production use)

#### C1 — A daemon can be paired exactly once, ever. Losing the token file bricks the account permanently, and the README tells the user to do the one thing that cannot work.

Three rules interact, each reasonable alone:

1. One daemon per account, enforced in three places — service layer at claim time
   (`pairing.ts:28-30`), again at redemption time (`pairing.ts:48-51`), and a DB partial
   unique index (`db/schema.ts:66`).
2. `POST /devices/unpair` always targets **the caller**, identified by its own bearer token
   (`server.ts:295-307`: `store.deleteDevice(device.id)` where `device` is the authenticated
   caller). There is no `DELETE /devices/:id`. Confirmed by grep — this is the only unpair
   path in the codebase.
3. The daemon never calls `/devices/unpair`. `packages/daemon/src/` contains no reference to
   it (grep: zero hits outside relay/web).

So the *only* actor that can unpair the daemon is the daemon itself, and it has no code to do
it. `SettingsScreen`'s "Unpair this device" button (`SettingsScreen.tsx:254`) calls
`unpairDevice(token)` with the **browser's** token — it unpairs the browser.

**Failure scenario (ordinary, not adversarial):** user pairs their laptop. Six months later
they reinstall the OS / get a new laptop / delete `~/.companion/`. New daemon prints a code.
They enter it. Relay returns `409 "Account already has a paired daemon — unpair it first"`
(`server.ts:146`). They go to Settings → Unpair → it signs them out of the browser and
changes nothing about the daemon. They repeat forever. **There is no recovery path short of
SQL.** The only workaround is signing up with a different email.

`packages/daemon/README.md:63-65` states: *"An account may have only one daemon at a time —
pairing a replacement means unpairing the existing one first (Settings → Unpair)."* That
sentence describes a capability that does not exist.

**Fix (smallest correct one):** add `DELETE /devices/:id` scoped to `device.userId` of the
caller, plus a device list in Settings. If that's too much for now, the 10-line version:
`POST /devices/unpair-daemon` — authenticated as any of the caller's devices, deletes the
account's daemon device row and calls `hub.disconnectDevice()` on it. Either way, fix the
README sentence in the same commit.

#### C2 — There is no way to start a session. The product's only entry point is an undocumented, unauthenticated `curl` against localhost.

- The web UI has no start-session affordance anywhere. Grep for `start_session` across
  `packages/web/src`: **zero hits**. `SessionList` renders a list and a pairing form;
  `SessionDetail` renders controls for an *existing* session.
- The relay refuses to route it by design (`hub.ts:212-214`), and the daemon dispatcher
  refuses to accept it (`command-dispatcher.ts:12-13`). Both are deliberate and documented.
- That leaves `POST /sessions {projectPath, prompt}` on the daemon's loopback HTTP surface
  (`http-server.ts:21-28`) — which is unauthenticated (see `daemon-review.md` C1) and has no
  client. `packages/daemon/package.json` has **no `bin` field**; there is no CLI, no
  `companion start`, nothing.

So the documented user journey is: build the monorepo from source, `npm start` the daemon,
read the pairing code off the terminal, type it into the PWA — and then hand-craft an HTTP
POST to `localhost:4310/sessions` with a JSON body, because nothing in the product will do it
for you. The daemon README lists the endpoint but never shows a `curl` invocation.

This is the gap between "impressive demo" and "thing someone else can use". Everything else in
this review is smaller than this.

**Fix:** a `bin` entry in `packages/daemon/package.json` pointing at a small CLI:
`companion run "<prompt>"` posts to the local daemon with `cwd` as `projectPath` and prints
the session URL. That is ~40 lines and it turns the product on. (The `attach-session-findings.md`
exploration — attaching to an already-running Claude Code session — is the better long-term
answer, but it is not needed to unblock this.)

#### C3 — `npm test` truncates whatever database `DATABASE_URL` points at. There is no environment guard, no CI, no deploy artifact, and no health check.

`packages/relay/src/postgres-store.test.ts:30`:
```
await db.execute(sql`TRUNCATE TABLE users, devices, pairing_codes, sessions, session_events RESTART IDENTITY CASCADE`);
```
in a `beforeEach`. `packages/relay/vitest.config.ts:8` loads `.env` automatically, and the
root `package.json` `test` script is `npm run test --workspaces --if-present` — so **`npm test`
at the repo root** runs this. There is no assertion that the target is not production. The
person most likely to have `DATABASE_URL` exported in their shell pointing at prod is the
person deploying, and the command they'll type after a deploy is `npm test`.
`packages/relay/README.md:25-32` documents that tests wipe the DB, but documentation is not a
guard.

Compounding, on operability:
- **No CI.** No `.github/` directory at all (verified). Nothing runs these 86+ tests except a
  human remembering to.
- **No deployment artifact.** No `Dockerfile`, `Procfile`, `fly.toml`, or any `*.yml`/`*.yaml`
  anywhere in the repo (verified by find). The relay's deploy story is "npm run build && npm
  start, somehow, somewhere."
- **No health check.** Grep for `/health`/`healthz` across `packages/*/src`: zero hits. Every
  PaaS and every load balancer wants one, and `runMigrations` runs before `listen`
  (`main.ts:88`), so a slow migration looks identical to a hung process.
- **No `engines` field** in any package.json. `process.loadEnvFile` (`main.ts:17`) requires
  Node ≥ 20.6; a Node 18 host fails with a confusing `TypeError` at boot.

**Fix, in order of cost:** (a) in `postgres-store.test.ts`, refuse to truncate unless
`DATABASE_URL` matches an allowlist pattern or `COMPANION_TEST_DB=1` is set — five lines,
eliminates the worst outcome; (b) `GET /healthz` returning 200 with no DB touch, plus
`/readyz` doing `SELECT 1`; (c) a Dockerfile and a GitHub Actions workflow running
`npm run build && npm test` with a throwaway Postgres service container; (d) `"engines":
{"node": ">=20.6"}`.

#### C4 — Device tokens are eternal, invisible, unrevocable by anyone but themselves, and survive deletion of the Clerk account that created them. There is no user-data deletion path at all.

The full lifecycle, traced:

- **users** — created by `getOrCreateUserByClerkId` (`postgres-store.ts:16-23`) on first
  browser registration. **Never deleted.** No `deleteUser` in the `Store` interface
  (`store.ts:48-80`), no Clerk webhook handler in `server.ts`, no `user.deleted` handling
  anywhere (grep for `webhook`: zero hits).
- **devices** — one row per browser, minted at `server.ts:186`. Deleted only by that same
  device calling `/devices/unpair`. Clearing site data, using a private window, or switching
  browsers mints a *new* row and orphans the old one — **with its token still live**. There is
  no UI listing a user's devices, so the user cannot even see them.
- **Clerk is consulted exactly once**, at registration (`server.ts:175`). Every subsequent
  request authenticates against `devices.token_hash` alone (`server.ts:35-41`,
  `pairing.ts:67-69`). Therefore **deleting the Clerk account revokes nothing**: the orphaned
  device token still authenticates, still opens `/ws`, still receives every session event, and
  still routes `inject_prompt` commands.
- **sessions** — never deleted, only `dismissed = true` (`postgres-store.ts:164-171`).
- **session_events** — never deleted, never pruned. Full stop.
- **pairing_codes** — the one table that *is* swept (`postgres-store.ts:77`). Good.

**Why this is Critical and not just a GDPR checkbox:** a browser device token grants
`inject_prompt` on a live session, which is **arbitrary code execution on the victim's dev
machine** (the daemon feeds it straight to the agent, which will happily run shell commands
once permissions are approved — and the same token approves permissions). A credential with
that blast radius that (a) cannot be enumerated, (b) cannot be revoked by its owner, and (c)
outlives the identity that minted it, is not shippable to strangers. The relay review's I9
covers token rotation; this is the lifecycle half of it.

**Fix:** (a) `GET /devices` + `DELETE /devices/:id` scoped to the caller's `userId` (this also
fixes C1 — same endpoint); (b) a Clerk `user.deleted` webhook that cascades delete
devices → sessions → session_events for that `userId`; (c) while you're there, a
`DELETE /account` doing the same thing on the user's own request.

---

### Important (should fix before/soon after launch)

#### I1 — The daemon allows one session at a time; the entire rest of the stack is a multi-session dashboard. The contradiction is real but the fix is ~5 lines.

`session-manager.ts:22-27`:
```
startSession(projectPath: string, prompt: string): SessionRunner {
  if (this.activeSessionId) {
    throw new Error(
      `Cannot start a new session while session ${this.activeSessionId} is active. Stop it first.`
    );
```
`activeSessionId` clears only on a `stopped` event or `stopSession` (`session-manager.ts:34-37,
65-67`). Combined with one-daemon-per-account (C1), an account can have **at most one live
session, ever**.

**What the user experiences:** the dashboard at `/` is a list that will contain exactly one
non-stopped row plus a pile of stopped-not-dismissed ones. `sort-sessions.ts`'s two-tier
priority ("which session needs me most") sorts a list of one. The `subscribe(sessionId, …)`
per-session fan-out in `use-sessions-store.ts:195-208` multiplexes a stream that only ever
carries one session's events. None of it is *broken* — it is unexercised. And the second time
the user tries to start something while the first is still open, they get a raw 400 with the
message above, from a `curl` (see C2), with no UI anywhere to explain it.

**This is worth fixing precisely because it is cheap.** Everything downstream is already
multi-session-correct: `SessionRunner` is per-session and tags every event with its own
`sessionId`; the relay keys sessions by id and broadcasts to a user's browsers unscoped
(`hub.ts:277-283`); the web store is a list keyed by id. Delete the guard, delete
`activeSessionId`, keep `sessions: Map<string, SessionRunner>`, and change `getActiveSession()`
callers. The daemon-side risk is resource contention between concurrent agent subprocesses,
not correctness. Also clean up the map — stopped runners are retained forever (see
`daemon-review.md` I7).

#### I2 — `paused` is a `SessionStatus` that no event can ever produce, so the Resume button in the UI is permanently disabled. `resume` is a dead command.

`SessionStatus` has five values (`events.ts:3-9`) but **no event carries a status**, and there
is no `paused` event in the union. Trace a pause:

1. `SessionControls.tsx:19` sends `{type:'pause'}`. Relay routes it. Daemon runs
   `SessionRunner.pause()` (`session-runner.ts:90-100`): `await interrupt()`, then
   `this._status = 'paused'`. **No `emit()` call.**
2. The interrupt's resulting SDK `result` message would become `turn_complete`, but
   `session-runner.ts:211` deliberately suppresses it while paused — so *nothing at all*
   leaves the daemon.
3. Relay's status is unchanged. `STATUS_BY_EVENT_TYPE` (`hub.ts:24-32`) has no entry that
   maps to `'paused'`, and neither does the web copy (`use-sessions-store.ts:20-28`).
4. `SessionControls.tsx:11`: `const canResume = status === 'paused';` — **this is never true**.
   The Resume button is disabled forever. Meanwhile `canPause` (`:10`) stays true, so the user
   can click Pause repeatedly on an already-paused session.

The user's only escape is to type a follow-up prompt, because `injectPrompt`
(`session-runner.ts:57-68`) doesn't check for `paused` and sets `_status = 'running'` as a side
effect. So the feature half-works by accident, via a control that isn't labelled "resume".

`STATUS_LABEL.paused = 'Paused'` (`SessionStatusBar.tsx:13`) is dead code, as is the `paused`
value in the DB enum (`db/schema.ts:83`).

**Fix:** add `status_changed { sessionId, status, at }` to `SessionEvent`, emit it from
`pause()`/`resume()`/`injectPrompt()`, and give both `STATUS_BY_EVENT_TYPE` maps an entry that
reads `event.status`. (`daemon-review.md` I1 proposes the same event from the daemon side —
this is the UI consequence that makes it Important rather than cosmetic.) One-line stopgap if
you want it today: emit `turn_complete`'s suppression as an explicit event, or have `pause()`
emit `{type:'error'}`— no, don't; do the `status_changed` event.

#### I3 — No protocol version, and an unknown event type causes the *entire frame* to be discarded silently on every consumer.

There is no version field anywhere in `RelayMessage` (`relay.ts:5-18`). `SessionEvent` is a
`z.discriminatedUnion`, so an unrecognized `type` is a hard parse failure, and every consumer
handles that by dropping the message and logging to a place nobody reads:

- Web: `relay-connection.ts:119-125` → `this.onLog('Received an unparseable frame from the relay')`
  → `console.log('[relay]', …)` (`use-sessions-store.ts:161`).
- Daemon: `relay-client.ts:110-114` → same, to stdout.
- Relay: `server.ts:398-413` → replies with a `{kind:'error'}` diagnostic frame **which both
  clients then discard as unparseable**, because it isn't a `RelayMessage`. (`daemon-review.md`
  I6 covers that specific loop.)

**Concrete scenario:** you add `status_changed` (per I2) and deploy the relay + web. An
installed iOS PWA that hasn't been foregrounded in a week is running the old bundle. It
receives `status_changed` frames, drops each one silently, and shows a session frozen at its
last known status — with the "live" green pill lit, because the socket is fine. The user
concludes the app is broken, not stale.

**Actual risk rating: moderate, not severe.** `registerType: 'autoUpdate'`
(`vite.config.ts:19`) means the service worker self-heals on the next load, so the window is
one app launch, not forever. And a *new field on an existing type* is safe — Zod strips unknown
keys by default, so old↔new is fine for additive field changes. The danger is confined to
**new event types and renamed/removed fields**, and to the fact that the failure is silent.

**Fix (cheap, do it before the next protocol change):** (a) add `v: number` to the
`RelayMessage` envelope so the relay can log version skew and clients can warn; (b) make the
event parse lenient at the edges — try `SessionEvent`, and on failure fall back to
`z.object({ type: z.string(), sessionId: z.string(), at: z.number() }).passthrough()` so an
unknown event still advances `lastEventAt` and renders as a neutral "…" row instead of
vanishing; (c) parse the `{kind:'error'}` diagnostic frame instead of discarding it.

#### I4 — `PubSub` is in-memory, so the relay is hard-limited to one instance. Deploying two replicas silently half-breaks every user.

Confirmed: `InMemoryPubSub` (`in-memory-pubsub.ts`) is a `Map<string, Set<handler>>` in process
memory, and `main.ts:91` instantiates it unconditionally — there is no env var to swap it, and
no Redis implementation exists.

**Blast radius with 2 replicas behind a normal round-robin LB** (daemon lands on A, browser
lands on B — a coin flip per connection, so ~50% of users):

- **Live events:** `routeFromDaemon` (`hub.ts:203`) publishes to A's local pubsub;
  `dispatchLocal` (`hub.ts:277`) iterates only A's connection map. The browser on B receives
  **nothing** live. The UI shows the green "live" pill (the socket to B is genuinely open) with
  a session frozen at whatever `GET /sessions/active` returned on load. Reloading appears to
  fix it (REST hits the shared Postgres) — which will send you hunting in entirely the wrong
  place.
- **Commands:** `routeFromBrowser` (`hub.ts:222`) publishes on B; the daemon is on A. Approve,
  Deny, Pause, Stop, and every prompt you type **do nothing, with no error** — the browser's
  `sendCommand` succeeded, so `relay-connection.ts:75-82` doesn't even log. A session blocked on
  a permission prompt can never be unblocked.
- **Rate limiters** (`rate-limiter.ts`) are per-process, so effective limits become N× the
  intended value. The relay review's C2 shows those limits are already load-bearing.
- **Push notifications keep working** (sent from `routeFromDaemon`, `hub.ts:208`) — so the phone
  buzzes "Needs your permission", the user taps through, and the Approve button does nothing.
  That's the worst possible combination.
- **Daemon disconnect-grace timers** (`hub.ts:129-135`) are per-process, which is actually fine.

The code is honest about this (`relay/README.md:190-195`, `rate-limiter.ts:1-9`). The risk is
purely that nothing *enforces* it: there is no startup assertion, no comment in a deploy config
(there is no deploy config), and the failure mode when someone scales to 2 is silent and
misattributable.

**Fix now (10 minutes):** if `process.env.COMPANION_RELAY_REPLICAS` / any multi-instance signal
is set, or simply always, log a prominent `WARNING: in-memory PubSub — this relay cannot run
more than one instance` at boot, and put it in the README's deploy section. **Fix properly:**
`RedisPubSub implements PubSub` using `PUBLISH`/`SUBSCRIBE` with `JSON.stringify` — the port is
already exactly right for it (3 methods), and `hub.ts` needs zero changes.

#### I5 — Only the WebSocket payloads are in the protocol package. Every REST request and response shape is hand-duplicated in each consumer and cast with `as`, unvalidated.

`packages/protocol/src/relay.ts` defines four *request* schemas and **zero response schemas**.
So each consumer re-declares the shapes it expects and trusts them:

- `packages/web/src/api/sessions.ts:4-19` re-declares `SessionRecord` and `StoredSessionEvent`
  — and its `SessionRecord` is **already drifted**: it omits `dismissed`, which
  `packages/relay/src/store.ts:36` has. Line 36: `return (await res.json()) as SessionRecord[];`
  — a cast, not a parse.
- `packages/web/src/api/devices.ts:4-9` re-declares `DeviceInfo`; `:19`, `:42`, `:60` all cast.
- `packages/daemon/src/device-auth.ts:73-77` casts the pairing-code response, and `:117-127`
  casts the poll response, to hand-written inline types.

Every one of these is a silent runtime break if the relay changes a field name, in exactly the
part of the system (pairing, session list) where a break is hardest to diagnose. Note that this
is the *opposite* discipline from the WebSocket path, which parses rigorously on both sides —
so the codebase already knows how to do this.

Secondary issue in the same seam: `GET /sessions/active` returns whole DB rows
(`server.ts:200`), including `userId` and `daemonDeviceId`, which no client uses. That's
unnecessary internal-id exposure and it widens the contract you have to keep stable.

**Fix:** move the response shapes into `packages/protocol/src/relay.ts` as Zod schemas
(`SessionSummaryResponse`, `StoredSessionEventResponse`, `DeviceInfoResponse`,
`PairingPollResponse`), have the relay build responses from them (dropping `userId`/
`daemonDeviceId`), and replace every `as X` in web/daemon with `X.parse(...)`.

#### I6 — A crashed session sends two push notifications; the service worker's `tag` collapses them, so the error message never reaches the user.

`NOTIFICATION_TITLE_BY_EVENT_TYPE` (`hub.ts:40-45`) fires for both `error` and `stopped`. The
daemon always emits them back-to-back: `drainMessages`' catch emits `error` and then calls
`finalize('crashed')`, which emits `stopped` (`session-runner.ts:165-173` → `:138`).

Both notifications carry `url: '/sessions/<id>'` (`hub.ts:250`), and the service worker uses
that url as the notification `tag` (`sw.ts:26`) — deliberately, to collapse repeats. So the
second notification **replaces** the first. The user's phone shows:

> **Session stopped**
> /Users/me/projects/foo

The `error` event's `message` — the only thing that says *what went wrong* — is never sent to
the phone at all: `hub.ts:249` sets `body` to `session.projectPath` for every event type except
`turn_complete`. So the push channel actively discards the one piece of information the user
needs, and then hides the notification that would at least have said "error".

**Fix:** for `error`, set `body` to the event's `message` (truncated the same way
`lastAssistantTextOrProjectPath` truncates at 140 chars), and either suppress the follow-on
`stopped` notification when an `error` for the same session was just sent, or give error
notifications a distinct tag (`${url}#error`) so they don't collapse into the stop.

#### I7 — `turn_complete` pushes fire even when the user is actively typing in the app.

`turn_complete` → "Claude is waiting for you" (`hub.ts:42`) fires on **every** completed turn,
with no check of whether the user is looking at that session right now. The relay has no way to
know — but the service worker does, and doesn't look: `sw.ts:22-29` calls `showNotification`
unconditionally.

Result: a user having a normal back-and-forth conversation in the PWA gets a notification
buzz for every single reply, from the app they are currently using. This is the fastest way to
get push permission revoked, which then breaks the feature's actual use case (being away from
the machine).

**Fix, entirely in `sw.ts`:** before showing, `const clients = await
self.clients.matchAll({type:'window'})`; if any client has `visibilityState === 'visible'` and
its `URL.pathname === payload.url`, skip `showNotification` (optionally `postMessage` the client
instead). This is the standard pattern and browsers permit the skip when a visible client
exists. ~8 lines.

#### I8 — Two env vars have defaults that are wrong-but-silent in production; a partial VAPID config disables push with no error.

Full enumeration is in the table at the end. The three that will actually bite:

- **`COMPANION_RELAY_CORS_ORIGIN`** — defaults to `['http://localhost:5173']`
  (`server.ts:58`, applied at `:103`). A production deploy that forgets it starts cleanly,
  logs "Companion relay listening on…", passes any health check you add — and **every browser
  request fails CORS**. The user sees a blank app and a console error they'll never look at.
  The README warns about this (`relay/README.md:71-73`) but the code doesn't.
- **`VITE_RELAY_HTTP_URL`** — defaults to `http://localhost:8787` (`config.ts:25`), *baked into
  the bundle at build time*. A CI build that forgets it produces an artifact that looks fine,
  signs in fine (Clerk is client-side), and then fails every relay call. The derived-WS-URL
  logic (`config.ts:16-20`) shows the author already learned this lesson once for the WS half;
  the HTTP half still has the trap.
- **VAPID trio** — `main.ts:75-85` requires all three; with two of three set (one typo'd
  variable name), push is silently disabled with a `console.log` that is indistinguishable from
  the intentional case. Also, none of the three appear in `.env.example`.

**Fix:** at relay boot, throw if `COMPANION_RELAY_CORS_ORIGIN` is unset and
`NODE_ENV === 'production'` (note: `NODE_ENV` is currently read nowhere in the relay). Throw if
*some but not all* VAPID vars are set. On the web side, fail the Vite build if
`VITE_RELAY_HTTP_URL` is unset and `mode === 'production'` — same treatment
`VITE_CLERK_PUBLISHABLE_KEY` already gets at `main.tsx:13`.

#### I9 — The full event history is re-downloaded on every session open, and `tool_use.input` carries whole file contents.

Two independent facts that multiply:

1. `SessionDetail.loadHistory` calls `getSessionEvents(token, sessionId)` with **no**
   `sinceSeq` (`SessionDetail.tsx:79`) → `GET /sessions/:id/events` with no `since` →
   `postgres-store.ts:189-196` with `sinceSeq = 0` → **every event ever recorded for that
   session**, no `LIMIT`, no pagination. (`relay-review.md` I7 covers the endpoint; this is the
   client that always asks for everything, on every navigation into a session, on a phone.)
2. `tool_use.input` is `z.unknown()` (`events.ts:29`) and is stored and forwarded verbatim
   (`session-runner.ts:191`, `hub.ts:202`). For a `Write` that is the **entire file body**; for
   `Edit`, both the old and new strings.

**Rough sizing, from how Claude Code actually behaves:** a busy hour is on the order of
100–200 tool calls → roughly 400–600 events/hour (one `tool_use` + one `tool_result` per call,
plus `assistant_text` blocks and a `turn_complete` per turn). Row *count* is a non-issue —
Postgres does not care about 100k rows. **Byte size is the issue:** 40 file writes averaging
15 KB = ~600 KB of event payload for a single afternoon's session, every byte of which is
(a) broadcast live over the WebSocket to every connected browser, (b) stored forever, and
(c) re-fetched in full each time the user taps into that session on their phone. A long-lived
session in a big file crosses into multiple MB over cellular.

**When it bites:** not at 1 user with 20-minute sessions. It bites the first time someone
leaves a session running all day and then opens it on their phone on mobile data — the detail
view will hang on "Loading…" for a long time with no progress indicator. And nothing consumes
the full `input` except `ModifiedFilesPanel` (which reads only `file_path`/`notebook_path`,
`modified-files.ts:16-21`) and `PermissionPrompt` (which needs it only for the one *pending*
request).

**Fix:** (a) truncate `tool_use.input` in the daemon before emitting — keep a size cap (say
2 KB) plus a whitelist of the fields the UI actually uses; (b) have `SessionDetail` fetch the
last N events (`?limit=200`) and add a "load earlier" affordance; (c) add `LIMIT` + a cursor to
`GET /sessions/:id/events` regardless, since it's currently an unauthenticated-cost amplifier
for any authenticated user.

#### I10 — There is no root README, and nothing anywhere tells the daemon operator how Claude authenticates to Anthropic.

- **No root `README.md`** (verified — repo root has `package.json`, `tsconfig.base.json`,
  `.gitignore`, `docs/`, `packages/`). A new user cloning this has no entry point: no
  "what is this", no "install", no dependency order, no note that `npm run build` must run
  protocol-first (the root `build` script does sequence it correctly, but nothing says so).
  Setup is scattered across three package READMEs, each of which assumes you already know
  about the other two.
- **The Anthropic credential is undocumented.** `real-agent-sdk.ts:1` imports
  `@anthropic-ai/claude-agent-sdk` and calls `query()` with no auth configuration, so it relies
  entirely on ambient credentials (an existing Claude Code login, or `ANTHROPIC_API_KEY` in the
  daemon's environment). `packages/daemon/README.md`'s Configuration section lists four
  `COMPANION_*` vars and **does not mention this at all**. A user who installs the daemon on a
  fresh box gets a session that immediately emits an `error` event whose text comes from deep
  inside the SDK.
- The daemon also logs nothing when `COMPANION_RELAY_URL` is unset (`main.ts:39`) — it just
  silently runs local-only, which is indistinguishable from "the relay connection is broken".

**Fix:** a root README with a 10-line quickstart covering both processes and the Anthropic
credential; a `console.log('COMPANION_RELAY_URL not set — running local-only, no phone access')`
in the daemon's else branch.

---

### Minor

- **M1 — `relay/README.md:202-206` is stale:** it says push fires for "`permission_request`,
  `error`, and `stopped` events". `hub.ts:40-45` also includes `turn_complete` (the
  waiting-for-input feature). One-line doc fix.
- **M2 — `GET /devices/daemon-status`** (`server.ts:282-293`) is missing from the relay
  README's endpoint list, despite being the thing that decides whether a new user sees the
  onboarding flow (`SessionList.tsx:29`).
- **M3 — No `engines` field**, and `process.loadEnvFile('.env')` (`main.ts:17`,
  `vitest.config.ts:8`, `drizzle.config.ts:6`) resolves relative to **CWD**, not the package —
  so `node packages/relay/dist/main.js` from the repo root silently skips `.env`. Harmless in
  production (env set directly), confusing locally.
- **M4 — `GET /sessions/active` leaks `userId` and `daemonDeviceId`** to the client
  (`server.ts:200` returns raw rows). No client reads them. Narrow the response (see I5).
- **M5 — `web/src/api/sessions.ts:4-12` `SessionRecord` omits `dismissed`** — existing drift
  from `relay/src/store.ts:28-37`. Currently harmless; it's the canary for I5.
- **M6 — `NODE_ENV` is read nowhere in the relay.** No production/development distinction
  exists in the code at all, which is why I8's fail-fast suggestions have nothing to hang off.
- **M7 — `command_failed` for an unknown session is dropped in a loop:** `main.ts:58-65`
  emits it with `command.sessionId`; the relay's `routeFromDaemon` rejects events for unknown
  sessions (`hub.ts:192-195`) and replies with a `{kind:'error'}` frame the daemon discards as
  unparseable (I3). So the one case `command_failed` was designed for — "you referenced a
  session that doesn't exist" — is exactly the case where it can't be delivered.

---

### Event/Command coverage matrix

**`SessionEvent` × consumers.** Line refs: relay statuses `hub.ts:24-32`; web statuses
`use-sessions-store.ts:20-28`; feed `ActivityFeed.tsx:27-49`; notifications `hub.ts:40-45`.

| Event type | relay `STATUS_BY_EVENT_TYPE` | web `STATUS_BY_EVENT_TYPE` | `ActivityFeed.describeEvent` | relay `NOTIFICATION_TITLE_BY_EVENT_TYPE` |
|---|---|---|---|---|
| `session_started` | — *(special-cased, `hub.ts:175-189` → `running`)* | — *(special-cased, `:71-82` → `running`)* | ✓ `Session started in {projectPath}` | — |
| `assistant_text` | `running` | `running` | ✓ *(raw text)* | — |
| `tool_use` | `running` | `running` | ✓ `Used {toolName}` | — |
| `tool_result` | — *(status unchanged)* | — *(status unchanged)* | ✓ `{toolName} completed/failed` | — |
| `permission_request` | `waiting_permission` | `waiting_permission` | ✓ | `Needs your permission` |
| `permission_resolved` | `running` | `running` | ✓ | — |
| `turn_complete` | `waiting_input` | `waiting_input` | ✓ `Turn complete` | `Claude is waiting for you` |
| `error` | `stopped` | `stopped` | ✓ `Error: {message}` | `Session error` |
| `command_failed` | — *(deliberate, documented both sides)* | — *(deliberate, `:14-19`)* | ✓ `Command failed: {message}` | — |
| `stopped` | `stopped` | `stopped` | ✓ `Session stopped` | `Session stopped` |

**Verdict: no gaps.** Every event type is described by the feed; every status-map omission is
intentional and commented identically on both sides. The two maps are **byte-identical** — I
diffed `hub.ts:24-32` against `use-sessions-store.ts:20-28` and the diff is empty.

**On the deliberate duplication:** it is a landmine, but a small one, and the current mitigation
(matching comments pointing at each other, `use-sessions-store.ts:14-19`) is weaker than it
needs to be. The map is 7 lines of pure data with no runtime dependencies — it belongs in
`packages/protocol` as `export const STATUS_BY_EVENT_TYPE`, imported by both. Both packages
already depend on `@companion/protocol`. There is no reason for this to be duplicated *at all*;
moving it is a 15-minute change that removes the whole class of drift. Do it. (The genuinely
un-shareable part — that the relay writes to Postgres and the web writes to React state —
isn't in the map.)

**Status coverage gap:** `SessionStatus` defines five values but only four are reachable
end-to-end. Nothing can ever produce `paused` outside the daemon's own memory — see I2.

**`Command` × consumers.** Line refs: dispatcher `command-dispatcher.ts:10-35`; daemon HTTP
`http-server.ts`; web triggers as noted.

| Command | daemon `dispatchCommand` | daemon local HTTP | relay routing | Web UI trigger | Reachable by a user? |
|---|---|---|---|---|---|
| `start_session` | throws (`:12-13`) | `POST /sessions` — bypasses dispatcher (`http-server.ts:21-28`) | rejected by design (`hub.ts:212-214`) | **none** | **Only via hand-written `curl` to localhost** (C2) |
| `inject_prompt` | ✓ `:14-16` | `POST /sessions/:id/prompt` | ✓ | `PromptInjectionBox.tsx:17` | ✓ |
| `respond_to_permission` | ✓ `:17-21` | `POST /sessions/:id/respond` | ✓ | `PermissionPrompt.tsx:13` | ✓ |
| `pause` | ✓ `:22-24` | `POST /sessions/:id/pause` | ✓ | `SessionControls.tsx:19` | ✓ *(but produces no visible effect — I2)* |
| `resume` | ✓ `:25-27` | `POST /sessions/:id/resume` | ✓ | `SessionControls.tsx:27` | **NO — button can never enable (I2)** |
| `stop` | ✓ `:28-30` | `POST /sessions/:id/stop` | ✓ | `SessionControls.tsx:35` | ✓ |

**Verdict: one dead UI command (`resume`) and one command with no UI at all (`start_session`).**
No command is unhandled by the dispatcher, and the `never` guard at `:31-34` guarantees that
stays true.

---

### Environment variables

| Var | Package | Required? | Fails fast? | Documented? | Notes |
|---|---|---|---|---|---|
| `DATABASE_URL` | relay | **yes** | ✓ `main.ts:25-31` | README + `.env.example` | `npm test` **truncates it** (C3) |
| `CLERK_SECRET_KEY` | relay | **yes** | ✓ `main.ts:33-39` | README + `.env.example` | — |
| `COMPANION_RELAY_PORT` | relay | no (8787) | ✗ — `Number()` unvalidated | README | Garbage value → `listen(NaN)` |
| `COMPANION_RELAY_HOST` | relay | no (`0.0.0.0`) | n/a | README | Intentionally public |
| `COMPANION_RELAY_TRUST_PROXY` | relay | no (0) | ✓ validated `main.ts:43-53` | README | Wrong value collapses rate limits — see `relay-review.md` C2 |
| `COMPANION_RELAY_CORS_ORIGIN` | relay | no (**localhost:5173**) | ✗ | README + `.env.example` | **Dangerous default (I8)** |
| `COMPANION_RELAY_VAPID_PUBLIC_KEY` | relay | no | ✗ silent | README only | Partial config silently disables push (I8) |
| `COMPANION_RELAY_VAPID_PRIVATE_KEY` | relay | no | ✗ silent | README only | ” |
| `COMPANION_RELAY_VAPID_SUBJECT` | relay | no | ✗ silent | README only | ” |
| `NODE_ENV` | relay | — | — | ✗ | **Read nowhere** (M6) |
| `COMPANION_DAEMON_PORT` | daemon | no (4310) | ✗ | README | — |
| `COMPANION_RELAY_URL` | daemon | no | n/a | README | Unset = silently local-only, no log (I10) |
| `COMPANION_DEVICE_NAME` | daemon | no (hostname) | n/a | README | — |
| `COMPANION_DEVICE_TOKEN_PATH` | daemon | no (`~/.companion/…`) | n/a | README | Losing this file bricks the account (C1) |
| *Anthropic credential* | daemon | **yes, implicitly** | ✗ — surfaces as an `error` event | **✗ nowhere** | **(I10)** |
| `VITE_CLERK_PUBLISHABLE_KEY` | web | **yes** | ✓ `main.tsx:13` | README + `.env.example` | Good model for the others |
| `VITE_RELAY_HTTP_URL` | web | no (**localhost:8787**) | ✗ | README + `.env.example` | **Dangerous default, baked at build time (I8)** |
| `VITE_RELAY_WS_URL` | web | no (derived) | n/a | README | Derivation logic is correct and well-reasoned |

---

### Assessment — what would actually break first in real use?

**The first thing to break is that nothing starts.** A second user cannot use this product at
all without being told, out of band, to `curl -X POST localhost:4310/sessions` with a JSON body
— there is no CLI, no `bin`, no UI button, and no README that says so (C2). Assume that's
solved with a shell alias. Then the first *real* break is the daemon pairing dead-end (C1): the
moment anyone reinstalls, changes machines, or clears `~/.companion/`, their account is
permanently unable to pair a daemon, and the error message points them at a Settings button
that unpairs their browser instead. That's not a slow-burn scale problem; it's a one-way door
that a single ordinary user action walks through, and it has no recovery short of SQL. Behind
those, the pause/resume dead-end (I2) is what a user hits on day one *while things are
working* — they pause, the Resume button stays grey forever, and the only way out is to type
something into the prompt box. The relay's single-instance constraint (I4) and the unbounded
event history (I9) are genuinely later problems — the first is a deploy decision you control
and can gate with one log line, and the second needs a multi-hour session on cellular before
anyone notices. The one that should worry you disproportionately relative to its current
visibility is C4: browser device tokens grant `inject_prompt` (arbitrary code execution on the
owner's dev machine), are minted on every fresh browser profile, are listed nowhere, are
revocable only by themselves, and keep working after the Clerk account that created them is
deleted. That is fine while the user list is you; it is the thing you must fix before it is
anyone else.
