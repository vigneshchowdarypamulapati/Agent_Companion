# Project 2 — Reliable transport layer (design notes)

Staged outside the repo so a concurrent agent's `git add` can't sweep it up.
Move into `docs/superpowers/specs/` once the security branch is free.

## Problem statement

Every finding in review Theme A is one missing layer: the system has no
delivery guarantees in either direction, and no way to tell a live socket
from a dead one. For an app whose entire premise is "control a session from
a phone" — a device that sleeps, changes networks, and backgrounds
constantly — this is the foundational defect, not a collection of bugs.

Concretely, today:
- Events emitted while the daemon's relay socket is down are **destroyed**
  (daemon C2). Worst case: a lost `session_started` makes the relay reject
  every subsequent event for that session, so it runs invisibly forever.
- No ping/pong on either side (daemon I5, relay I1) — a half-open socket
  swallows everything for minutes.
- The web client has no liveness detection at all (web C2): after the phone
  sleeps it shows a green "live" badge over stale data.
- `PromptInjectionBox` clears your typed text while the command is dropped
  to `console.log` if the socket is closed (web C3) — silent data loss on
  the app's single most important interaction.
- Reconnect gap-fill can duplicate events and regress `lastSeq` (web I1).
- There is no request/response shape at all, which is why session adoption
  (Project 3) has nowhere to put "list the sessions I could adopt".

## Design — six pieces

### 1. Outbound event durability (daemon → relay)

Per-daemon monotonic sequence number on every event. The daemon keeps an
in-memory ring of unacknowledged events; the relay acks by sequence; on
reconnect the daemon replays everything after the last ack.

Bound the buffer (size AND bytes). On overflow, drop oldest and emit an
explicit `events_dropped` marker so the UI can say "some activity is
missing" rather than silently showing an incomplete history. Honesty over
false completeness.

Deliberately **not** persisted to disk: sessions live in the daemon
process, so a daemon restart means the sessions are gone anyway. Persisting
the buffer would imply a durability guarantee the session layer cannot
honour.

### 2. Heartbeat, both directions

WebSocket ping/pong (the `ws` library supports this natively — do not
invent an application-level ping). Relay pings every connection on an
interval and terminates ones that miss N pongs. Daemon and browser both
treat "no ping received within the window" as a dead connection and
reconnect. This is what makes a half-open socket detectable at all.

### 3. Command acknowledgment (browser → relay → daemon)

Commands get an id. The daemon acks receipt, and the relay routes the ack
back to the originating browser. The UI moves through
pending → delivered → failed instead of assuming success.

This is what fixes web C3, and it is the highest-value change in the
project: `PromptInjectionBox` must not clear the input until the command is
acknowledged, and must restore the text with a visible error if it fails.
Losing what someone typed is the worst possible failure for this app.

### 4. Device-scoped request/response (RPC)

Every command today is session-scoped, and `routeFromBrowser` validates
`command.sessionId` against an existing owned session. "List sessions I
could adopt" has no session id yet.

Add `rpc_request`/`rpc_response` with a correlation id, routed
browser → the user's daemon via `getDaemonDeviceForUser`, with a timeout
and a typed error result. This is the seam Project 3 needs, and it also
opens the door to daemon health and project listing later.

### 5. Client-side liveness

`visibilitychange` (verify/reconnect on resume — the single most important
one for a phone), `online`/`offline`, and heartbeat timeout all feed one
connection-state machine. The "live" badge must reflect that machine's real
state, never merely "we once opened a socket".

### 6. Gap-fill correctness

Track the max applied seq and ignore anything at or below it, so the
reconnect refetch is idempotent. Fixes the duplicate-append and `lastSeq`
regression.

## Also folded into this project

**Lift the daemon's one-session limit** (`SessionManager.startSession`
throws while `activeSessionId` is set). The rest of the stack — dashboard,
relay, store — is already multi-session; this is the last single-session
assumption, and Project 3 (adoption) is not useful until it is gone.

## Sequencing note

Do the protocol/schema additions first (sequence numbers, ack messages, RPC
envelope) as one task, since daemon, relay, and web all depend on them.
Then daemon durability, then relay ack/heartbeat/RPC routing, then the web
client state machine, then the UI feedback. The one-session lift is
independent and can go anywhere.

## Constraint discovered during Project 1

Relay tests `TRUNCATE` a shared database, so any two agents running them
concurrently corrupt each other. All relay-touching work must be
serialized, and CI (Project 6) will need a per-job database or Neon branch.
