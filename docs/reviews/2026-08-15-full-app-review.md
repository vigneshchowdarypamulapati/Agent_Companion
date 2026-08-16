# Claude Companion — full app review + "adopt an existing session" design

Four independent Opus reviews (daemon / relay / web / cross-cutting), each
reading real source and verifying claims. Raw detail:
`daemon-review.md`, `relay-review.md`, `web-review.md`,
`crosscutting-review.md`, `attach-session-findings.md`.

Totals: **13 Critical, 49 Important, 45 Minor.** That number is less
important than the shape, below.

---

# Part 1 — The headline finding

**You cannot start a session from the app.** Verified directly:

- No UI anywhere references `start_session` (grep: zero hits outside tests).
- The relay *explicitly refuses* to route it — `hub.ts:212`:
  `throw new Error('start_session cannot be routed through the relay')`.
- The daemon exposes no CLI and no `bin`. The only way to create a session
  is `curl -X POST localhost:4310/sessions` on the dev machine itself, via
  an endpoint its own README calls "for local development and testing only".

So the real workflow today is: *shell into your laptop and curl a JSON body
to create a session, then monitor it from your phone.* Nobody will do that.
Every real Claude Code session — the ones started by typing `claude` in a
terminal — is **completely invisible to this app**.

This is why the "what if I forgot to start it through the daemon" question
is not an edge case. It is the **only** case. That reframes Part 2 from a
nice-to-have into the app's missing front door.

---

# Part 2 — Findings by theme

Ranked by what actually breaks the product, not by raw severity counts.

## Theme A — The connection cannot be trusted (biggest cluster)

The entire premise is "control a session from your phone". A phone sleeps,
switches networks, and backgrounds constantly. Every layer mishandles this:

| Where | Problem |
|---|---|
| daemon C2 | Events emitted while the relay socket is down are **destroyed** — no buffer, no replay. A dropped `session_started` makes the relay reject every later event for that session, so it runs invisibly forever. |
| daemon I5 / relay I1 | No ping/pong heartbeat on either side. A half-open socket silently swallows events for minutes. |
| web C2 | No liveness detection at all (no heartbeat, no `visibilitychange`, no `online`). After the phone sleeps, the badge cheerfully says **"live"** over stale data. |
| web C3 | `PromptInjectionBox` clears your typed text unconditionally, while `relay-connection.ts:76` drops the command to `console.log` if the socket is closed. **Your reply vanishes and nothing happens.** |
| web I1 | The reconnect gap-fill can duplicate events and regress `lastSeq`. |

**web C3 directly breaks the feature shipped yesterday.** The whole flow is
"get a push → tap it → reply from your phone". If the socket is half-open —
the normal state for a phone that just woke up — the reply is silently
eaten. This is the single highest-value fix in the review.

## Theme B — Pause is broken end-to-end (confirmed first-hand)

`paused` is a valid `SessionStatus` that **no event can ever produce**:
`grep paused packages/relay/src/hub.ts` → nothing; the daemon's `pause`/
`resume` cases in `command-dispatcher.ts:22-27` emit no events at all. So
the status never leaves the daemon, the phone never sees `paused`, and
`SessionControls`' Resume button — gated on `status === 'paused'` — can
**never** enable. Pause from the phone is a one-way trip into a state the UI
cannot represent or exit.

Three reviewers found this independently. I also fixed a related bug in
yesterday's branch (pause firing a false "Claude is waiting for you" push).
Pause is the most broken feature in the app.

## Theme C — Security (three genuinely exploitable)

1. **Daemon's local HTTP surface is unauthenticated with no `Host` check**
   (`http-server.ts` + `main.ts:34`) and starts unconditionally, including
   in production. Any web page you visit can DNS-rebind to
   `127.0.0.1:4310` and start Claude Code sessions with full tool access on
   your machine. The README calls this surface dev-only; nothing enforces that.
2. **Pairing code is ~20 bits** (`randomInt(0, 1e6)`), a wrong guess costs
   the attacker nothing, and the only defence is an in-memory counter that
   every deploy resets. Guessing one re-points a victim's daemon at the
   attacker's account — and `inject_prompt` is then code execution on the
   victim's dev machine.
3. **`trust proxy: 0`** (the value in code *and* `.env.example`) collapses
   both IP-keyed limiters into one global bucket behind any PaaS load
   balancer. ~80 unauthenticated requests lock out **every** user from
   pairing and registration, repeatable indefinitely.

Also real but lower: SSRF via the push endpoint (validated only as "an
https URL"), device tokens that never expire and travel in the WS query
string, no CSP.

**Verified clean** (worth knowing): no cross-user data exposure on any route
or WS path, no SQL injection (the `sql` tagged template is properly
parameterized), pairing claim/redeem races are correctly closed, and no XSS
vector exists in the current code.

## Theme D — The phone is told the wrong story

- **daemon C4**: every `SDKResultMessage` subtype collapses to
  `turn_complete`. Hitting max-turns, exhausting budget, or an execution
  error all reach your phone as the push **"Claude is waiting for you"**.
  You'd tap it expecting a question and find a dead session.
- **cross-cutting I6**: a crash emits `error` then `stopped`, but the
  service worker's `tag` collapses the two notifications — so the error
  message never reaches the phone at all.
- **cross-cutting I7**: `turn_complete` pushes fire even while you're
  actively typing in the app.

## Theme E — Operability and lifecycle

- **No CI, no Dockerfile, no health check, no root README, no `engines`.**
- **`npm test` runs `TRUNCATE` against whatever `DATABASE_URL` points at,
  with no guard.** One stale env var away from wiping production.
- **A daemon can be paired exactly once, ever.** Lose the token file and the
  account is permanently bricked — and the daemon README points users at a
  Settings button that unpairs their *browser* instead.
- **Device tokens outlive Clerk account deletion.** There is no user-data
  deletion path at all.
- **In-memory `PubSub` hard-limits the relay to one instance.** Deploy two
  replicas and live events plus all commands silently break for ~50% of
  users — while push keeps firing, so it looks half-working.
- Unbounded growth in several places: `session_events` never pruned and
  `getSessionEvents` has no `LIMIT`; the daemon's in-memory `eventLog`;
  the rate limiter never evicts keys.

## Theme F — Mobile (both platforms)

There is **zero platform-specific code** — no iOS-only assumptions, no
user-agent branching. Android is at full parity today, and is actually the
*stronger* platform: Android Chrome supports web push without installing the
PWA, while iOS requires home-screen install and 16.4+.

Two confirmed gaps are worse against Android's guidelines than iOS's:
- **`theme-color` meta tag is missing** (verified: 0 occurrences in
  `index.html`). Android Chrome tints the status/address bar from it.
- **36px touch targets** on Approve/Deny — Android Material's floor is 48dp.

Plus, cross-platform: no text wrapping utilities anywhere (long file paths
force horizontal page scroll at 375px), `assistant_text` newlines collapse
into one run-on paragraph, the service worker never updates itself (no
`skipWaiting`/`clientsClaim` despite `registerType: 'autoUpdate'`), no
`aria-live` regions, and no error boundary (any render throw = permanent
white screen).

## Verified positives

Worth stating plainly, because they were checked and are genuinely fine:
the two deliberately-duplicated `STATUS_BY_EVENT_TYPE` maps are currently
**byte-identical**; every `SessionEvent` type is handled by `ActivityFeed`;
every `Command` is handled by the daemon dispatcher; no cross-user leakage;
no SQL injection.

---

# Part 3 — Design: adopting an already-running session

## What the SDK actually gives us (measured, not assumed)

Verified on this machine — full detail in `attach-session-findings.md`:

- `listSessions({ includeProgrammatic: false })` returns real terminal
  sessions with `sessionId`, a human-readable `summary` (the session's first
  prompt or `/rename` title), `cwd`, `lastModified`, and `fileSize`. It
  correctly **excludes** Companion's own SDK sessions — the same filter the
  terminal `/resume` picker uses. This is a ready-made session picker.
- `query({ options: { resume: sessionId } })` continues the **same** session
  id, appending to the same transcript.
- `getSessionMessages()` on a **94.9 MB** transcript: **1.6 s, 383 MB RSS**.
  Fine once, at adoption. Fatal as a polling loop.

## The one thing we cannot do: detect liveness

There is no "currently open in a terminal" signal anywhere. `SDKSessionInfo`
has no such field; `~/.claude/ide/*.lock` files are VS Code IDE-connection
locks carrying no session id (and were 8 days stale on this machine while
sessions ran). `lastModified` is the only signal, and it is one-directional:
*recently written* means almost certainly live mid-turn, but *quiet* proves
nothing — an idle session sitting at a prompt writes nothing.

This is the design's central constraint. It must be handled with **UX, not
detection**.

## Recommended design: adopt by takeover

**Discover → confirm → adopt.**

1. **Discover.** The phone asks the daemon for adoptable sessions; the
   daemon answers with `listSessions({ includeProgrammatic: false })`,
   showing title, project path, and "last active 25 minutes ago".
2. **Confirm.** If `lastModified` is within ~30 s, **refuse** — it is almost
   certainly mid-turn in a live terminal. Otherwise require an explicit
   confirm: *"Make sure this isn't still open in a terminal — continuing it
   in two places will corrupt the conversation."* We cannot detect it, so we
   must say so honestly rather than pretend.
3. **Adopt.** The daemon backfills the last ~50 messages via
   `getSessionMessages` (so the phone has context), then opens
   `query({ options: { cwd, resume: sessionId } })` and wraps it in an
   ordinary `SessionRunner`. From that moment it is a completely normal
   Companion session — every existing feature (permissions, prompt
   injection, stop, the new `waiting_input` push) works unchanged.

**Use the Claude session id as the Companion session id.** Adoption becomes
naturally idempotent (adopting twice upserts the same row), and the relay
already permits the owning daemon to re-send `session_started`.

The end state is lovely: the adopted session sits idle with no turn running,
which is exactly `waiting_input` — so the phone shows **"Waiting for you"**
plus Claude's actual last message, straight into the reply box shipped
yesterday.

## Rejected alternatives (and why)

- **Watch-only (tail the transcript, never take over).** Zero conflict risk,
  and appealing. Rejected for v1 on the measurement above: polling
  `getSessionMessages` costs 1.6 s / 383 MB per poll on a large session, and
  the alternative — parsing raw JSONL by byte offset — means depending on an
  undocumented on-disk format and building a second event pipeline parallel
  to `SessionRunner`. Large cost, and it can't reply, which is the point.
- **Fork instead of resume** (`forkSession: true`). Safe — new session id,
  original untouched — but it *diverges*: work done from the phone never
  appears in the terminal session, so returning to your desk finds a stale
  thread. Continuity is the whole value when you walk away mid-task. Worth
  offering later as an explicit "work on a copy" escape hatch.

## Prerequisite

**The daemon allows exactly one session at a time** —
`SessionManager.startSession` throws `Cannot start a new session while
session X is active`, and `activeSessionId` only clears on `stopped`. The
entire rest of the stack is already multi-session (the dashboard, the relay,
the store). The cross-cutting reviewer put the fix at ~5 lines with
everything downstream already correct. Adoption is not useful until this is
lifted — you could adopt a session only when you have no other.

## The one architectural addition

Every existing command is session-scoped, and `routeFromBrowser` validates
`command.sessionId` against an existing owned session. "List the sessions I
could adopt" has no session id yet, so it needs a **device-scoped
request/response channel** to the user's daemon (routed via
`getDaemonDeviceForUser`) alongside today's session-scoped one. This is a
real protocol addition, and it is the right one — it also unlocks future
needs like daemon health and project listing.

## What to prove first

`resume` combined with a **streaming** (async-generator) prompt — how
`realQueryFn` already drives every session — is not explicitly documented as
a supported combination, though nothing in the types forbids it. A throwaway
script should confirm this before any implementation work. If it fails, the
adoption design still works but needs a different prompt-feeding strategy.

---

# Part 4 — Suggested sequencing

Fix order, reasoning from "what makes the product actually usable":

1. **Adoption + lift the one-session limit** — the missing front door.
   Without it there is no realistic way to get a session into the app.
2. **Theme A (connection trust)**, starting with **web C3** — silently
   eating the user's typed reply breaks yesterday's feature.
3. **Theme C security**, starting with the daemon's unauthenticated loopback
   surface and the 20-bit pairing code.
4. **Theme B (pause)** — either wire a real `paused` event end-to-end or
   remove the button until it works. Shipping a dead control is worse than
   shipping none.
5. **Theme D (error fidelity)** — cheap fixes, high trust payoff.
6. **Theme E/F** — the `TRUNCATE`-in-tests guard is a five-minute fix that
   prevents a catastrophe; the rest is steady hardening.

CONSTRAINT (discovered): relay tests TRUNCATE the shared companion_test DB, so relay-touching agents must be serialized -- concurrent runs corrupt each other. Also blocks parallel CI jobs later (Project 6: give CI its own DB or a per-job Neon branch).
