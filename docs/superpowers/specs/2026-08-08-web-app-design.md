# Claude Companion — Web App (PWA) Design Spec

**Date:** 2026-08-08
**Status:** Approved for planning

## Problem

The daemon and relay are built and merged: a developer's Claude Code session runs locally, driven by the daemon, and streams events to/from a hosted relay over WebSocket. Nothing can see or control that session remotely yet — there is no client. This spec covers the third component: a mobile-first web app that pairs with the relay, shows a live view of the active session, and lets the developer answer questions, inject prompts, and pause/resume/stop — from any browser.

## Non-goals

- **Push notifications while no tab is open.** The relay does not implement Web Push yet (`packages/relay/README.md`: "Web Push notification delivery is not implemented"). This app works over the live WebSocket connection while a tab is open/foregrounded; waking a phone with no tab open is explicitly deferred to a follow-up plan that adds relay-side push delivery.
- **A CLI or admin tool for generating pairing codes.** The web app is self-sufficient for pairing (see below) — no separate tooling is added.
- **Multiple simultaneous sessions.** The daemon enforces one active session at a time; the web app reflects that.
- **`daemon_unreachable` visibility.** No such `SessionStatus` value exists in the protocol yet (a gap already noted as deferred work after the daemon-relay integration plan). This app cannot distinguish "the daemon's relay link is down" from "the daemon just isn't emitting anything right now."
- **End-to-end browser automation testing.** Component/unit tests only (Vitest + React Testing Library, plus a real-local-WebSocket-server test for the connection hook). The daemon-relay wire protocol is already proven end-to-end by the previous plan's integration test.

## Architecture

A new `packages/web` package: Vite + React + TypeScript, Tailwind CSS for styling, `vite-plugin-pwa` for the installable-to-homescreen manifest and service worker. No router library — the app has exactly two top-level views, selected by whether a device token is present in `localStorage`:

```
[No token] ──> PairingScreen ──(pair)──> [token stored] ──> Dashboard
                                                                 │
                                                    (401 / token cleared)
                                                                 │
                                                                 ▼
                                                          PairingScreen
```

The app talks only to the relay's REST and WebSocket APIs (`packages/relay`) — it has no server component of its own and builds to static files. Hosting is a deploy-time choice, same as the relay's.

### Relay addition: `GET /sessions/active`

The relay's REST API currently requires already knowing a session ID (`GET /sessions/:id`, `GET /sessions/:id/events`). The web app's first requirement — show the current session on load, or "No Active Sessions" if none — needs to discover a session ID with nothing to go on but the device's own auth token. This spec adds:

- `Store.getActiveSessionForUser(userId): Promise<SessionRecord | undefined>` — returns the caller's session whose `status !== 'stopped'`, if any. Under v1's one-daemon-one-active-session model there is at most one.
- `GET /sessions/active` on the relay — same `Authorization: Bearer <token>` pattern as the existing `/sessions/:id` routes; `200` with the session record if one exists, `404 { error: 'No active session' }` otherwise.

This is additive to the already-merged `packages/relay` (new `Store` method + new route), not a change to any existing behavior.

## Components

- **`PairingScreen`** — "Get a pairing code" button (calls `POST /pairing/request-code`, displays the code and its expiry) and an "Enter pairing code" input (calls `POST /pairing/redeem` with `deviceType: 'browser'`). On success, persists `{ token, deviceId }` to `localStorage` and switches to `Dashboard`. Pairing-code failures (invalid/expired) show an inline error; no token is stored.
- **`Dashboard`** — top-level container once paired. On mount: fetches the active session and catch-up event history (see Data Flow), then opens the live WebSocket via `useRelayConnection`. Renders:
  - **`SessionStatusBar`** — current status (`running` / `waiting_permission` / `paused` / `stopped`) and project path, or the "No Active Sessions" empty state.
  - **`ActivityFeed`** — chronological list of all session events (assistant text, tool use/result, turn complete, errors, `command_failed`).
  - **`ModifiedFilesPanel`** — de-duplicated list of file paths derived client-side from `tool_use` events whose `toolName` is a file-editing tool (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`), reading the path out of each event's `input`. No protocol or daemon changes — this is purely a web app view over data that already flows through.
  - **`PermissionPrompt`** — appears when status is `waiting_permission`; shows the pending tool name/input and Approve/Deny controls, sending `respond_to_permission`.
  - **`PromptInjectionBox`** — text input + send, sending `inject_prompt`. Disabled while `waiting_permission`, mirroring `SessionRunner`'s own guard so the UI doesn't offer an action that would just come back as `command_failed`.
  - **`SessionControls`** — Pause / Resume / Stop, each enabled only when the current status allows it (mirroring `SessionRunner`'s status guards for the same reason as above).
- **`useRelayConnection`** — a hook owning the WebSocket connection lifecycle: connects to `wss://<relay>/ws?token=<token>`, parses inbound `{kind:'event', sessionId, seq, event}` frames, exposes `sendCommand(command)` which sends `{kind:'command', sessionId, command}`, and reconnects with exponential backoff on disconnect. This is the single source of live state for `Dashboard`.

## Data Flow

On `Dashboard` mount:
1. `GET /sessions/active` (Bearer auth). `404` → render "No Active Sessions" and stop here (still open the WebSocket, so a session started later shows up live).
2. If found: `GET /sessions/:id/events?since=0` for full history, render it into `ActivityFeed`/derived panels.
3. Open the WebSocket. Live events append to state, de-duplicated against catch-up history by the relay-assigned `seq` (never trust local ordering alone).

Commands (`inject_prompt`, `respond_to_permission`, `pause`, `resume`, `stop`) go out over the same WebSocket as `{kind:'command', sessionId, command}` frames; the relay's existing `ConnectionHub` routes them to the daemon device that owns the session. A `command_failed` event coming back is shown as an inline/toast message — it does not change what the Dashboard displays as the session's status (that's the entire reason `command_failed` was split out from `error` in the previous plan).

## Error Handling

- **Pairing failure:** inline error on `PairingScreen`, no token persisted.
- **WebSocket disconnect:** `useRelayConnection` reconnects with backoff (same confirm-before-reset shape as the daemon's `RelayClient`, since the relay's accept-before-authenticate timing applies to any WS client, not just the daemon), and a small "reconnecting…" indicator shows on `Dashboard`. On reconnect, re-fetch `GET /sessions/:id/events?since=<lastSeenSeq>` to fill any gap missed while disconnected.
- **401 from any relay call:** clear the stored token and return to `PairingScreen` (the token was revoked or is otherwise invalid).
- **Daemon-side relay disconnects:** not distinguishable from the daemon simply being idle (see Non-goals) — this app makes no attempt to show a separate "daemon offline" state in v1.

## Security

- The device token is stored in `localStorage` (not sessionStorage), matching the daemon's own persist-and-reuse pattern — a browser tab closing shouldn't force re-pairing every time.
- The token is only ever sent as `Authorization: Bearer <token>` (REST) or the `?token=` query param (WebSocket handshake, per the relay's existing constraint that browsers cannot set headers on a WS handshake) — never logged, never rendered to the DOM.
- `GET /sessions/active` follows the same anti-enumeration posture as the existing `/sessions/:id` routes: no way to distinguish "no active session" from "session belongs to someone else" beyond the `404`.

## Testing Strategy

- **Component tests** (Vitest + React Testing Library): `PairingScreen` (both flows, error states), `Dashboard`'s status/empty-state rendering, `PermissionPrompt`/`SessionControls` gating logic, `ModifiedFilesPanel`'s derivation logic.
- **`useRelayConnection` hook:** tested against a real local `WebSocketServer` test double (matching `packages/daemon/src/relay-client.test.ts`'s established style — a real socket, not a mock), covering event forwarding, command sending, reconnect-with-backoff, and seq-gap catch-up refetch.
- **Relay addition:** `Store.getActiveSessionForUser` and `GET /sessions/active` get the same test treatment as the existing `Store`/route test suites in `packages/relay` (in-memory store unit test + REST route test, including the "no active session" and anti-enumeration cases).
- No Playwright/browser-automation e2e in this plan (see Non-goals).

## Open items for the implementation plan

- Exact Tailwind config / design tokens (color palette, spacing scale) — pick sensible mobile-first defaults at implementation time; not a product decision worth blocking this spec on.
- Whether `vite-plugin-pwa`'s generated manifest needs a real app icon set now or a placeholder — placeholder is fine for v1, swap later.

## Future work (explicitly deferred, not ruled out)

- **Web Push notifications.** Relay-side subscription storage + VAPID-key send-on-`permission_request`, plus the web app's subscription UI. A distinct follow-up plan, not a task folded into this one.
- **`daemon_unreachable` session status.** Needs a protocol change plus relay-side detection of a daemon's WS disconnect while it owns an active session — revisit alongside Web Push, since both are about the app being useful when nobody's watching the tab.
