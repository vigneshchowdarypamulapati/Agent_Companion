# Claude Companion — Design Spec

**Date:** 2026-08-07
**Status:** Approved for planning

## Problem

Developers using Claude Code have to stay physically at their laptop because Claude
frequently pauses to ask a clarifying question or request permission. Claude Companion
lets a developer monitor and control an active Claude Code session from any browser or
mobile device, so they don't have to babysit the terminal.

## Non-goals

- Companion does not start Claude Code, open VS Code, launch projects, or act as a
  remote desktop.
- Companion does not attach to or remote-control an already-running *interactive*
  terminal/VS Code Claude Code session (not technically possible — see Feasibility
  below). It drives its own SDK-managed sessions instead.
- v1 does not include public signup, billing, or admin/abuse tooling. The system is
  *architected* to support many users later, but v1 ships with a single seeded account
  for personal use.

## Feasibility constraint (why the architecture looks like this)

Claude Code (CLI and VS Code extension) exposes no public API for an external process
to inject prompts into, or pause/resume/stop, an already-running *interactive* session.
It only exposes:

- **Hooks** — shell commands fired on events (`Notification`, `Stop`, `PreToolUse`,
  `PostToolUse`, etc.) that can push data *out*, but can't receive commands back in.
- **The Claude Agent SDK** — lets a program drive a Claude Code session
  programmatically: send messages, interrupt, resume, inspect tool calls. This gives
  full two-way control, but the caller (not a human at a terminal) is the one driving
  the conversation.

Because the product requires real two-way control (inject prompts, pause, resume,
stop, answer questions), Companion is built on the **Agent SDK model**: a local daemon
drives Claude Code sessions programmatically, and the web app is a remote control for
that daemon — not a window onto an independently-running terminal.

## Architecture

Three components, chosen to scale from "just me" to "many users" without a rewrite:

```
[Companion Daemon]  <--outbound WS-->  [Relay Server]  <--WS/HTTPS-->  [Web App (PWA)]
   (your laptop)                        (cloud, stateless,                (phone/browser)
   owns Agent SDK                        Postgres + Redis)
   session(s))
```

1. **Companion Daemon** (Node/TypeScript, runs on the developer's laptop)
   Owns and drives Claude Code session(s) via the Claude Agent SDK. Captures every SDK
   event (tool calls, file edits, questions/permission prompts, turn completion) and
   streams them to the Relay over a **persistent outbound** WebSocket — the laptop
   never opens an inbound port. Exposes commands: start, inject prompt, respond to
   question, pause, resume, stop.

2. **Relay Server** (Node/TypeScript, hosted, the only publicly reachable piece)
   A stateless WebSocket + REST service. Pairs a user's daemon connection(s) with
   their browser connection(s), forwards events one way and commands the other, and
   holds Web Push subscriptions so it can wake a phone even with no tab open. Holds no
   session state in process memory — state lives in Postgres, cross-instance message
   routing goes through Redis pub/sub — so it can run as N instances behind a load
   balancer from day one.

3. **Web App / PWA** (React + TypeScript)
   Mobile-first, installable to homescreen. Live dashboard (current session status,
   activity feed, modified files), question/response UI, prompt injection box,
   pause/resume/stop controls. Receives Web Push notifications when Claude is blocked
   waiting on input.

All three share a single `@companion/protocol` package: Zod schemas for every
WebSocket event/command, so the contract between daemon, relay, and web app is
type-checked end to end instead of drifting.

## Data model

Every table is scoped by `user_id` from day one, even though v1 has exactly one user
row, so multi-tenancy is additive later rather than a migration nightmare.

| Table | Purpose | Key columns |
|---|---|---|
| `users` | account | id, email, created_at |
| `devices` | paired daemons + browsers | id, user_id, type (`daemon`\|`browser`), name, token_hash, last_seen |
| `sessions` | one Claude Code session | id, user_id, daemon_device_id, project_path, status (`running`\|`paused`\|`waiting_input`\|`daemon_unreachable`\|`stopped`), started_at, ended_at |
| `session_events` | append-only activity log | id, session_id, type, payload_json, created_at |
| `push_subscriptions` | Web Push endpoints | id, user_id, device_id, endpoint, keys |

`session_events` is what powers "recent activity," lets a reconnecting client replay
history instead of only seeing live state, and is the durable log that makes relay
restarts non-destructive.

v1 constraint: the daemon enforces **one active session at a time**, but internally
it's modeled as `SessionManager: Map<sessionId, SessionRunner>` specifically so
relaxing that limit later doesn't require a redesign.

## Key flows

- **Pairing a device:** an already-authenticated device requests a short-lived (5 min),
  single-use 6-digit pairing code from the relay; the new device submits the code and
  receives a long-lived, capability-scoped device token (daemon tokens can only act as
  that daemon; browser tokens can only command that user's sessions).
- **Starting a session:** developer starts a session via the daemon (local command)
  against a project path. Daemon creates a `SessionRunner`, opens an Agent SDK session,
  inserts a `sessions` row, broadcasts `session.started`.
- **Claude asks a question:** SDK emits a waiting-on-input event → `SessionRunner`
  writes a `session_events` row, sets session status `waiting_input`, broadcasts over
  WS, fires Web Push. Reply flows back as a `respond` command through the same channel.
- **Inject prompt / pause / resume / stop:** typed command from the web app → relay
  looks up which daemon connection owns that session (Postgres/Redis) → forwards →
  `SessionRunner` calls the matching Agent SDK method → result flows back as an event.
- **Reconnect / catch-up:** client reconnects, fetches current session status + last N
  `session_events` via REST, then resumes the live WS stream. Postgres being the source
  of truth means no state is lost across relay restarts or phone sleep.

## Error handling

- **Daemon offline:** session status becomes `daemon_unreachable` (distinct from
  `paused`); commands sent while unreachable fail fast with a clear error rather than
  queuing indefinitely.
- **Relay restart:** both sides reconnect with backoff; no session state is lost since
  it lives in Postgres/Redis, not relay process memory — only a brief event-stream gap,
  filled by the reconnect catch-up fetch.
- **SDK session crash:** `SessionRunner` catches it, writes an `error` `session_events`
  row, sets session status `stopped`. A session is never left silently marked
  `running`.
- **Multiple browser devices:** all connected devices for a user receive every event
  (mirrored dashboards); any device can issue commands (last-write-wins — single
  operator, no locking needed).

## Security

- Daemon is outbound-only — no inbound port, no attack surface exposed on the laptop.
- Device tokens are capability-scoped and individually revocable from a device list.
- All traffic over TLS. Pairing codes are short-lived and single-use.
- Relayed payloads (file diffs, tool output) are not retained beyond a configurable
  retention window — the relay is a pipe plus a durable activity log, not a code
  archive.

## Testing strategy

- **Daemon:** unit tests for `SessionRunner` state transitions against a mocked Agent
  SDK; one integration test driving a real trivial SDK session end to end.
- **Relay:** integration test running two relay instances + Redis to verify
  cross-instance message routing actually works.
- **Web app:** component tests for question/response and command UI; a Playwright
  smoke test covering pairing → live update against a local daemon + relay.

## Open items for the implementation plan

- Exact Web Push provider/library choice (e.g. `web-push` npm package + VAPID keys).
- Hosting choice for the relay + Postgres + Redis (e.g. Fly.io/Railway) — functionally
  interchangeable, pick at implementation time.
- Monorepo layout (`packages/daemon`, `packages/relay`, `packages/web`,
  `packages/protocol`).
