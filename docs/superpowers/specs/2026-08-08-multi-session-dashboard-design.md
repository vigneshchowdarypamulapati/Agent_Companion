# Claude Companion — Multi-Session Dashboard Design Spec

**Date:** 2026-08-08
**Status:** Approved for planning

## Problem

The web app (`packages/web`, merged 2026-08-08) assumes exactly one active session per user: `GET /sessions/active` returns a single record, and `Dashboard.tsx` is built entirely around tracking that one session. In practice a developer can have Claude Code running in several project directories at once, each its own session. Right now those sessions have no coherent view — the dashboard just shows whichever one the relay happens to consider "the" active session and ignores the rest.

This spec replaces the single-session dashboard with a two-tier view: a list of every one of the user's active sessions, and a detail view (today's dashboard, essentially unchanged) for whichever one is opened. It supersedes the "Multiple simultaneous sessions" non-goal in `2026-08-08-web-app-design.md` — that constraint was a snapshot of v1 scope, not a permanent architectural limit, and the underlying daemon/relay/protocol already support it without changes (see Architecture).

## Non-goals

- **Session history.** The list shows active sessions plus stopped-but-undismissed ones (see Dismissal below) — never a log of everything that has ever run. Once dismissed, a session is gone from every view; nothing about past sessions is browsable.
- **Multi-daemon/device management UI.** A session's card shows its project path, not which daemon or machine it's running on. Distinguishing daemons is not a need this spec addresses.
- **Changing how sessions are started.** Starting a session remains exclusively a daemon/CLI action (`hub.ts` already rejects `start_session` from a browser); this spec only changes how already-started sessions are observed and dismissed.
- **Push notifications, settings/unpair UI.** Separate, already-sequenced specs.
- **`daemon_unreachable` visibility, Pause→Resume protocol gap.** Pre-existing gaps, unrelated to this change, still open from prior work.

## Architecture

One shared WebSocket connection, owned above the router, replaces today's one-hook-per-`Dashboard` model — the relay already broadcasts every event for every one of a user's sessions to every one of that user's browser connections, unscoped (`hub.ts`'s `dispatchLocal`), so a second connection would only duplicate traffic, not add capability.

```
                              SessionsProvider (owns the one WS connection,
                              the session-summary list, dismiss, sendCommand)
                                        │
                    ┌───────────────────┴───────────────────┐
                    │                                        │
              route: "/"                              route: "/sessions/:id"
              <SessionList>                            <SessionDetail>
              (reads summaries                         (reads one summary by id;
               from context)                            fetches + owns its own
                                                          full event history)
```

Routing uses `react-router` (added as a new dependency — the current industry-standard client-side router for React, and the only way to get real back-button/deep-link behavior in a PWA, which was the explicit reason it was chosen over in-app view state during design). Two routes: `/` and `/sessions/:id`. Both still sit behind the existing pairing gate in `App.tsx` — an unpaired device sees `PairingScreen` regardless of route.

### Why one shared connection instead of one per view

`SessionDetail` needs live events for one session (its full activity feed); `SessionList` needs live status/activity-time updates for *every* session, regardless of which one (if any) is currently open, so a background session's card stays accurate. A single connection at the top, fanning out to both concerns, is both cheaper (one socket, one reconnect/backoff cycle) and correctness-preserving (no risk of the list and the open detail view observing the same event stream in different orders through two independent sockets).

### Relay changes

`SessionRecord` gains two fields:

- `lastEventAt: number` — the `at` of the most recent event appended to this session (every `SessionEvent` variant already carries `at`; see `packages/protocol/src/events.ts`). Set to `startedAt` when the session is created, updated by `Store.appendSessionEvent`'s implementation on every subsequent append.
- `dismissed: boolean` — defaults `false`. Set `true` only by the new dismiss action, only when `status === 'stopped'`.

`Store` interface changes (`packages/relay/src/store.ts`):

- `getActiveSessionForUser(userId)` → `getActiveSessionsForUser(userId): Promise<SessionRecord[]>`. Returns every session for that user where `dismissed === false` — i.e. anything not yet stopped, plus anything stopped but not yet dismissed. No sorting contract; sorting is a presentation concern, done client-side (see Components).
- New: `dismissSession(sessionId: string, userId: string): Promise<'ok' | 'not_found' | 'forbidden' | 'not_stopped'>`. `InMemoryStore` implements the ownership and status checks directly; the route layer maps the result to an HTTP status.

Route changes (`packages/relay/src/server.ts`):

- `GET /sessions/active` now returns `200` with a JSON array (possibly empty) instead of `200`/`404` with a single record. Empty array replaces the old 404-for-nothing-active case.
- New `POST /sessions/:id/dismiss` — same Bearer-auth pattern as the existing session routes. `200` on success, `404` if the session doesn't exist or isn't owned by the caller (same non-enumerable-404 pattern already used by `GET /sessions/:id`), `409 { error: 'Session is not stopped' }` if `status !== 'stopped'`.

### Client changes (`packages/web`)

- **`use-sessions-store.ts`** (new hook, owned by `SessionsProvider`) — the single `useRelayConnection` call lives here. On mount, `GET /sessions/active` loads the initial `SessionSummary[]` (`{id, projectPath, status, lastEventAt}` — a subset of `SessionRecord`, no `userId`/`daemonDeviceId` needed client-side). Live events update the matching summary's `status` (via the same `STATUS_BY_EVENT_TYPE` map `Dashboard.tsx` already has — now defined once, here, instead of duplicated per view) and `lastEventAt`; a `session_started` event not yet in the map inserts a new summary. Events for a session not yet in the map, arriving before the initial load resolves, are buffered and replayed after load completes — the same buffer-then-drain pattern already proven in the current `Dashboard.tsx` (`pendingLiveEventsRef`/`loadedRef`/`loadGenerationRef`), now scoped to the whole map instead of one session.
- **`SessionsProvider.tsx` / `SessionsContext`** — thin context wrapper exposing `{ sessions: SessionSummary[], connected: boolean, loadError, dismissSession(id), sendCommand(sessionId, command), subscribe(sessionId, handler): () => void }`. `subscribe` registers a per-session raw-event listener (a `Map<string, Set<handler>>` internally) so `SessionDetail` can receive this one session's events without opening its own connection.
- **`SessionList.tsx`** (new) — sorted (`waiting_permission` first, then the rest by `lastEventAt` descending) list of cards: project path, status text, attention badge when `waiting_permission`, relative last-activity time. Each card links to `/sessions/:id`. Stopped sessions show a **Dismiss** button calling `dismissSession`; on success the summary is removed from context state (no need to wait for the removal to round-trip back through a live event). Empty state: "No active sessions."
- **`SessionDetail.tsx`** (renamed from `Dashboard.tsx`) — reads `id` from `useParams()`. Looks up its own summary via `sessions.find(s => s.id === id)` from context for status/projectPath (single source of truth, not re-derived locally) instead of tracking a separate copy as `Dashboard.tsx` does today. Still owns its own full `events: SessionEvent[]` — fetched via `GET /sessions/:id/events` on mount and kept live via `context.subscribe(id, handler)` — because that's expensive per-session state the list must never carry. If `id` isn't found in `sessions` (dismissed elsewhere, stale link, or the initial list load hasn't resolved yet — distinguished by `loaded`), shows either a loading state or a "Session not found" message with a link back to `/`. `SessionStatusBar`, `ActivityFeed`, `ModifiedFilesPanel`, `PermissionPrompt`, `PromptInjectionBox`, `SessionControls`, and `findPendingPermissionRequest` are unchanged.
- **`api/sessions.ts`** — `getActiveSession` → `getActiveSessions(token): Promise<SessionSummary[]>`; new `dismissSession(token, sessionId): Promise<void>` (throws on non-`200`, including a specific message for `409`).

## Data Flow

Two tiers, kept deliberately separate — this is the load-bearing decision from the design discussion (Approach B):

1. **List tier (cheap, always live).** One `GET /sessions/active` call on app load. From then on, every live event updates only the matching summary's `status`/`lastEventAt` in the shared map — never a full event array — regardless of which route is open. This is sufficient to keep the whole list correct in real time, including the attention badge, without ever fetching a session's full history.
2. **Detail tier (fetched on demand).** `GET /sessions/:id/events` fires only when `/sessions/:id` mounts. Only the currently-open session's full event log is held in memory; navigating away and the events are dropped (re-fetched fresh if reopened — acceptable since there's no "read position" to preserve, consistent with the no-history decision).

Dismissal: `SessionList` calls `POST /sessions/:id/dismiss`; on `200` the card is removed from local state immediately. On `409` (session wasn't actually stopped — a race with a live status flip) or `404`, an inline error shows on that card and it stays in the list, since the underlying state may have changed.

## Error Handling

- List-load failure (`GET /sessions/active` REST error, not 401): error banner at the top of `/`, same pattern as today's `loadError`. Cleared the moment a live event is successfully processed, same reasoning as the current implementation (live traffic proves the relay connection is healthy).
- Detail-load failure: same banner pattern, scoped to `/sessions/:id`, with a link back to `/`.
- Dismiss failure: inline on the card, not a full-page banner — it's a local, retryable action.
- Any `401` from any REST call: routes back to `PairingScreen` via the existing `onUnauthorized` callback, unchanged.
- WebSocket reconnect: unchanged reconnect/backoff behavior in `RelayConnection`; on reconnect with no prior successful load, `SessionsProvider` re-runs full discovery exactly as `Dashboard.tsx` does today, since a session may have started or stopped while the socket was down.

## Security

`dismissSession` checks `session.userId === device.userId` before mutating anything, the same ownership check every other session-scoped store/route call already makes — no new attack surface. The `GET /sessions/:id` non-enumerable-404 pattern (identical response whether a session is missing or owned by someone else) is preserved for the new dismiss route.

## Testing Strategy

Unchanged philosophy from the web app spec: component/unit tests only (Vitest + React Testing Library), no Playwright/e2e.

- `use-sessions-store`: unit tests mirroring today's `Dashboard.tsx` buffering tests — initial load, live update of an existing summary, live insert of a new one, buffer-then-drain ordering, reconnect-triggers-reload.
- Sort/badge logic: extracted as a small pure function (`sortSessions(summaries): SessionSummary[]`), unit-tested directly — same pattern as `deriveModifiedFiles`.
- `SessionList`: RTL tests for rendering, sort order, badge presence, dismiss button behavior (success removes the card, 409/404 shows the inline error and keeps it).
- `SessionDetail`: existing `Dashboard.test.tsx` coverage carries over almost unchanged, adapted to read `id` via a router param and status/projectPath via a mocked context instead of its own fetch+WS mocking.
- `packages/relay`: unit tests for `InMemoryStore.getActiveSessionsForUser` (dismissed filtering, stopped-but-undismissed inclusion) and `dismissSession` (ownership, status-guard, not-found cases), plus a route test for `POST /sessions/:id/dismiss`'s three status codes.

## Global Constraints

- No session history beyond "stopped but not yet dismissed" — dismissal is one-way and immediate on success.
- Exactly one WebSocket connection per browser tab, owned above the router.
- List-tier state never includes a full per-session event array; only the currently-open detail route holds one.
- `react-router` is the routing library (current industry-standard choice for React SPAs/PWAs).
