# Reliable Transport Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Companion real delivery guarantees in both directions, real liveness detection, and a device-scoped request/response channel — so a phone that sleeps, changes networks, and backgrounds can be trusted as a control surface.

**Architecture:** Split the single conflated `RelayMessage` union into four directional message types, then layer on: daemon-side outbound event buffering with ack-and-replay, WebSocket ping/pong heartbeats, end-to-end command acknowledgment, and an RPC envelope routed to a user's daemon rather than to a session. Finally, remove the daemon's last single-session assumption.

**Tech Stack:** TypeScript, Zod, `ws`, React 19, Vitest.

**Source of truth:** `docs/reviews/2026-08-15-full-app-review.md` (Theme A) and `docs/reviews/2026-08-16-transport-design-notes.md`. Each task cites the finding it closes.

## Global Constraints

- **Losing a user's typed input is the worst failure this app can have.** No task may leave a path where a command is accepted by the UI and silently discarded.
- **Push delivery and event routing must never throw.** All new failure paths stay best-effort, matching the existing posture in `ConnectionHub.notifyPush`.
- **Backward compatibility is NOT required.** There are no third-party clients; daemon, relay, and web all ship together. Prefer a clean protocol over a compatible one. However, an old cached service worker CAN serve an old web client — so the relay must reject an unrecognized message shape with a clear typed error rather than crashing or silently ignoring it.
- Relay tests `TRUNCATE` a shared database: **never run two relay test suites concurrently.**
- Relay Postgres tests require `COMPANION_TEST_DATABASE_URL` (already configured in the gitignored `packages/relay/.env`). Never point it at `DATABASE_URL`; never read, print, or commit `.env` contents.
- Every task ends with the full monorepo suite green. Baseline at the start of this plan: **603 passing, 1 skipped.**

---

### Task 1: Split the wire protocol into directional message types

**Closes:** the structural debt behind Theme A — `packages/protocol/src/relay.ts`'s single `RelayMessage` union covers all four directions at once, which is why `relay-client.ts:68` sends a meaningless `seq: 0` (the relay assigns the real seq from the store).

**Files:** `packages/protocol/src/relay.ts` (+ its test), and every consumer's type usage in `packages/daemon/src/relay-client.ts`, `packages/relay/src/hub.ts`, `packages/relay/src/server.ts`, `packages/web/src/relay-connection.ts`.

**Requirements:**

Replace `RelayMessage` with four Zod discriminated unions — `DaemonToRelayMessage`, `RelayToDaemonMessage`, `BrowserToRelayMessage`, `RelayToBrowserMessage` — carrying exactly these variants:

- **Daemon → relay:** `event` (with a daemon-assigned `deliverySeq: number`, and NO `seq` — the relay owns store sequencing); `command_ack`; `rpc_response`.
- **Relay → daemon:** `event_ack` (carrying the highest contiguous `deliverySeq` the relay has durably stored); `command`; `rpc_request`.
- **Browser → relay:** `command` (with a client-generated `commandId: string`); `rpc_request`.
- **Relay → browser:** `event` (with the store-assigned `seq`); `command_ack`; `rpc_response`.

Shapes for the new variants:
- `command_ack`: `{ kind: 'command_ack', commandId, status: 'delivered' | 'failed', message?: string }`. `delivered` means the daemon received and dispatched it — not that the work finished.
- `rpc_request`: `{ kind: 'rpc_request', requestId, method: string, params: unknown }`.
- `rpc_response`: `{ kind: 'rpc_response', requestId, result?: unknown, error?: string }` — exactly one of `result`/`error` present; enforce with a Zod refinement.
- `event_ack`: `{ kind: 'event_ack', deliverySeq: number }`.

`method`/`params` stay deliberately open (`z.string()` / `z.unknown()`) at this layer: the RPC method registry belongs to whoever implements the methods, not to the envelope. Task 6 defines the first method.

This task is a pure type/plumbing refactor — **no behavioral change**. Consumers should compile and all existing tests should pass unchanged except where a type name or the removed `seq: 0` forced an edit. If you find yourself changing runtime behavior here, stop: that belongs to a later task.

---

### Task 2: Daemon outbound event durability (buffer, ack, replay)

**Closes:** daemon C2 — events emitted while the relay socket is down are destroyed. Worst case: a lost `session_started` makes the relay reject every later event for that session, so a live session runs invisibly forever.

**Files:** `packages/daemon/src/relay-client.ts` (+ test); a new `packages/daemon/src/outbound-buffer.ts` (+ test) so the buffer logic is unit-testable without a socket.

**Requirements:**

- Assign a monotonic `deliverySeq` per daemon process to every outbound event.
- Hold unacknowledged events in an in-memory buffer. On reconnect, replay everything after the relay's last acked `deliverySeq`, in order, before sending anything new.
- `sendEvent` must **never silently drop** while disconnected — it buffers. Replace the `Dropping event …` log at `relay-client.ts:65`.
- Bound the buffer by **both** entry count and total bytes (choose and justify limits; a session streaming tool output can produce large events). On overflow, drop **oldest** and record that a drop happened.
- After any drop, the next successful send must be preceded by an `events_dropped` marker so downstream can honestly say activity is missing rather than presenting an incomplete history as complete. Add `events_dropped` to `SessionEvent` in `packages/protocol/src/events.ts` — it needs a `sessionId` like every other event, so if the buffer spans multiple sessions, emit one marker per affected session.
- Deliberately **not** persisted to disk: sessions live in the daemon process, so a daemon restart loses the sessions anyway. Persisting would imply a durability guarantee the session layer cannot honour. Document this reasoning in the module.

**Testing:** buffering while disconnected; ordered replay after reconnect; no re-send of acked entries; count-based and byte-based overflow each producing a marker; and the specific regression — `session_started` emitted while disconnected still reaches the relay after reconnect.

---

### Task 3: Relay — event acks, heartbeats, and connection liveness

**Closes:** daemon I5 + relay I1 — no ping/pong on either side, so a half-open socket silently swallows everything for minutes. Also relay I1's missing `maxPayload`.

**Files:** `packages/relay/src/server.ts`, `packages/relay/src/hub.ts` (+ tests).

**Requirements:**

- After durably storing an event (`appendSessionEvent` succeeded), send `event_ack` with the highest contiguous `deliverySeq` stored for that daemon connection. Ack the **highest contiguous** value, never a gapped one, or replay-after-reconnect will skip events.
- Use the `ws` library's native ping/pong — do NOT invent an application-level ping. Ping every connection on an interval; terminate connections that miss N consecutive pongs (choose and justify; roughly 30s interval / 2 misses is sane for mobile). Terminating must run the same cleanup path as a normal close, including the existing daemon-disconnect grace period.
- Set a WebSocket `maxPayload` (relay I1). Pick a limit that comfortably fits a large `tool_use` event but bounds abuse; justify it.
- An unparseable or unrecognized message must produce a typed error frame back to the sender and must not crash the connection or the process.

**Testing:** ack carries the highest contiguous seq and skips gaps; a connection missing pongs is terminated and cleaned up; an oversized frame is rejected without killing the process; a malformed frame yields an error frame.

---

### Task 4: Command acknowledgment end to end — never lose typed input

**Closes:** web C3, the single highest-value fix in the whole review. `PromptInjectionBox.tsx:17-18` clears the user's typed text unconditionally, while `relay-connection.ts:76-79` drops the command to `console.log` when the socket is closed. On a phone that just woke — the normal state when you tap a push notification — your reply vanishes and nothing happens.

**Files:** `packages/web/src/relay-connection.ts`, `packages/web/src/use-relay-connection.ts`, `packages/web/src/use-sessions-store.ts`, `packages/web/src/PromptInjectionBox.tsx`, `packages/web/src/SessionDetail.tsx`, `packages/relay/src/hub.ts`, `packages/daemon/src/relay-client.ts`, `packages/daemon/src/command-dispatcher.ts` (+ tests across all).

**Requirements:**

- Browser attaches a `commandId` to every command and tracks it as **pending** until acked.
- The daemon replies `command_ack` with `delivered` after dispatching, or `failed` with a message if dispatch threw. The relay routes the ack back to the originating browser. Note `command_failed` already exists as a `SessionEvent` for the failure case — do not duplicate it; `command_ack` is about *delivery*, `command_failed` is about *execution*. Make that distinction explicit in the code and keep both.
- If the socket is not open, the command must **queue** and flush on reconnect, or fail loudly after a timeout — never a silent `console.log` drop.
- **`PromptInjectionBox` must not clear the input until the command is acknowledged.** On failure or timeout, restore the text and show a visible, actionable error with a retry affordance. A disabled send button with a spinner is fine while pending; losing the text is not.
- Give the pending/failed state an `aria-live` announcement (web I9) — a phone user must not have to watch the button to learn their reply failed.

**Testing:** the exact regression — type a reply with the socket closed, confirm the text survives, the user sees an error, and retry works after reconnect. Plus: ack marks a command delivered; a daemon dispatch failure surfaces as failed; a command with no ack within the timeout surfaces as failed.

---

### Task 5: Web client connection state machine

**Closes:** web C2 (no liveness detection — the badge says "live" over stale data after the phone sleeps) and web I1 (reconnect gap-fill duplicates events and can regress `lastSeq`).

**Files:** `packages/web/src/relay-connection.ts`, `packages/web/src/use-relay-connection.ts`, `packages/web/src/use-sessions-store.ts`, `packages/web/src/SessionDetail.tsx`, `packages/web/src/SessionList.tsx`, `packages/web/src/SessionStatusBar.tsx` (+ tests).

**Requirements:**

- One explicit connection state — `connecting | live | reconnecting | offline` — derived from: socket state, heartbeat/ack recency, `navigator.onLine`, and `visibilitychange`. Every "live" indicator in the UI reads from this single source; none may report "live" merely because a socket was once opened.
- On `visibilitychange` → visible (the critical one for phones): verify the connection is genuinely alive and force a reconnect if not. A phone returning from sleep frequently holds a socket that looks open and is dead.
- Handle `online`/`offline`. When offline, say so honestly — do not render a relay-unreachable error as if the server were broken (cross-cutting I8 notes today's message blames the relay).
- Make gap-fill idempotent: track the max applied `seq` and ignore anything at or below it, so a reconnect refetch cannot duplicate-append or regress `lastSeq`.
- Reconnect backoff must be jittered so many clients waking at once do not synchronize into a thundering herd.

**Testing:** a dead-but-open socket is detected and reconnects on visibility change; the badge reflects true state in each of the four states; a gap-fill overlapping already-applied events applies nothing twice; offline renders an offline state, not a server error.

---

### Task 6: Device-scoped RPC routing

**Closes:** the missing seam identified in the adoption design — every command today is session-scoped, and `routeFromBrowser` validates `command.sessionId` against an existing owned session, so "list the sessions I could adopt" has nowhere to live.

**Files:** `packages/relay/src/hub.ts`, `packages/relay/src/server.ts`, `packages/daemon/src/relay-client.ts`, a new `packages/daemon/src/rpc-handlers.ts`, `packages/web/src/relay-connection.ts`, `packages/web/src/use-sessions-store.ts` (+ tests).

**Requirements:**

- Route `rpc_request` from a browser to **that user's daemon** via `getDaemonDeviceForUser`, and route the `rpc_response` back to the originating browser only. Enforce the same user-isolation discipline the existing paths have — the final review confirmed no cross-user leakage exists today and that property must hold.
- Correlate by `requestId`. Enforce a timeout with a typed error result. Bound the number of in-flight requests per device so a client cannot exhaust relay memory by never reading responses.
- If the user has no daemon, or it is disconnected, return a typed error the UI can render as a real explanation — not a hang and not a generic failure.
- Daemon side: a small method registry mapping `method` → handler, with **one** method implemented in this task as the proving ground: `ping` returning daemon version and uptime. Adoption's real methods land in Project 3.
- Web side: a promise-based `callDaemon(method, params)` that resolves/rejects, with the timeout surfaced as a rejection.

**Testing:** round-trip request/response; response reaches only the originating browser; another user's browser cannot address this daemon; timeout produces a typed error; no-daemon and disconnected-daemon each produce their own typed error; in-flight cap is enforced.

---

### Task 7: Lift the daemon's one-session limit

**Closes:** cross-cutting I1 — `SessionManager.startSession` throws `Cannot start a new session while session X is active`, while the dashboard, relay, and store are all already multi-session. This is the last single-session assumption, and Project 3 (adoption) is not useful until it is gone: you could only ever adopt a session when you had no other.

**Files:** `packages/daemon/src/session-manager.ts` (+ test), `packages/daemon/README.md`.

**Requirements:**

- Allow multiple concurrent sessions. Remove `activeSessionId` and the guard; keep the `sessions` map as the source of truth.
- Audit every remaining use of `getActiveSession()` and either remove it or make its multi-session semantics explicit — a method named "the active session" is a bug magnet once several can be active.
- Add a configurable maximum concurrent session count (env var, sane default, documented) so a runaway client cannot spawn unbounded Claude Code processes on the user's machine. Exceeding it must produce a clear error, not a silent refusal.
- Stopped sessions must be removed from the map so it cannot grow forever (daemon I7 notes unbounded growth in the daemon's own maps).
- Update the README, which documents "start the one active session".

**Testing:** two sessions run concurrently and their events stay correctly attributed; the cap is enforced with a clear error; a stopped session is evicted from the map.
