# Remote Session Start — Design

**Status:** Approved by user 2026-08-18, pending spec review before planning.

## Goal

Today, starting a Claude Code session under Companion's control is only possible by hand, on the
machine the daemon runs on: `POST /sessions` on the daemon's local-only HTTP surface (off by
default, bearer-token authenticated, bound to `127.0.0.1`). The phone can only observe and reply
to sessions someone already started this way. This spec makes starting a *new* session a first-
class phone action — safely, without reopening the DNS-rebinding-era hole the local surface was
hardened against — and, since the daemon's session concurrency cap has to be lifted to make that
useful, redesigns the parts of the mobile UI this touches so the whole flow feels like the
primary way to work, not a remote control bolted onto a desktop tool.

## Background: what's already true, verified against the current code

- `StartSessionCommand`'s `projectPath` is a completely unvalidated `z.string()` — nothing in the
  protocol or the daemon restricts it today.
- `SessionManager.startSession` (`packages/daemon/src/session-manager.ts`) throws if
  `this.activeSessionId` is set — a hard cap of exactly one active session per daemon.
- The relay and store already support many concurrent sessions per user structurally:
  `sessions_user_id_idx` is an index, not a unique constraint; `getActiveSessionsForUser` returns
  an array; `SessionList.tsx` already renders however many come back. The daemon's cap is the
  *only* blocker to real concurrency.
- The device-scoped RPC channel (reliable-transport Task 6) already gives a user's phone a
  request/response path to their own daemon, routed by the relay with no session involved, fully
  user-isolated, with a method registry (`packages/daemon/src/rpc-handlers.ts`) and a typed error
  set (`packages/protocol/src/rpc-errors.ts`). `ping` is the only method implemented so far. This
  spec adds the next two.
- `SettingsScreen.tsx`'s "Pair a daemon" form (line 175) has **no conditional around it at all**
  — confirmed by reading the file. It always renders. `getDevice`/`/devices/me` returns info
  about the *calling* device (the phone itself), never the paired daemon, so this screen has no
  way to know daemon-pairing state today. This is a real, standalone bug, fixed as part of this
  work because the new daemon-status card replaces the same UI region.

## Architecture

Two new daemon RPC methods, added to the existing registry — no relay changes needed for routing,
since Task 6's RPC path is already generic per-method:

- **`list_projects`** — the daemon reports every project it will accept a `start_session` call
  for: everywhere a session has run before, plus (if configured) every subdirectory of one root
  directory on the daemon's machine.
- **`start_session`** — takes a project path and initial prompt, re-validates the path against
  that same known/allowed set (never trusts the phone's word for it), and starts the session.

Three real daemon-side changes, one relay-side change, and a corresponding web-side redesign are
detailed below.

## Protocol changes (`packages/protocol/src`)

**New RPC error codes**, added to `RPC_ERROR_CODES` in `rpc-errors.ts`, following the existing
style (each with a doc comment explaining when it fires):

- `INVALID_PROJECT_PATH: 'invalid_project_path'` — the given path is not in the daemon's known
  history, not under the configured root (if any), or no longer exists on disk. One code covers
  all three causes: the remedy is identical from the caller's side (re-list, pick again), and
  distinguishing them risks leaking filesystem structure for no actionable benefit.
- `CONCURRENT_SESSION_LIMIT: 'concurrent_session_limit'` — the daemon already has
  `maxConcurrentSessions` non-stopped sessions running.

**`list_projects` RPC contract:**
- params: `null` (no arguments)
- result: `{ path: string; displayName: string; source: 'history' | 'configured'; lastUsedAt?: number }[]`
  — `displayName` is the final path segment (`path.basename`); `source` is `'history'` if the
  daemon has started a session there before (has a `lastUsedAt`), `'configured'` if it's only
  known because it's a subdirectory of `COMPANION_PROJECTS_ROOT` and has never been used.
  Sorted: `'history'` entries first by `lastUsedAt` descending, then `'configured'` entries
  alphabetically by `displayName`. Every returned path is verified to currently exist as a
  directory before being included — a project that was deleted or moved silently drops off the
  list rather than being offered and then failing at start time.

**`start_session` RPC contract:**
- params: `{ projectPath: string; prompt: string }`
- result on success: `{ id: string; status: SessionStatus }` — identical shape to what the local
  HTTP surface's `POST /sessions` already returns.
- result on failure: `{ error: 'invalid_project_path' | 'concurrent_session_limit' | 'handler_error' }`

## Daemon changes (`packages/daemon/src`)

**New file `project-store.ts`** — persists the known-projects list to
`~/.companion/daemon-projects.json` (overridable via `COMPANION_PROJECTS_FILE_PATH`, same override
pattern as `COMPANION_DEVICE_TOKEN_PATH`), written with `{ mode: 0o600 }` like the existing device
token file (`device-auth.ts`) — project paths reveal filesystem structure, so the same restrictive
permission applies. Shape: `{ projects: { path: string; lastUsedAt: number }[] }`. Exposes:
- `recordProjectUsed(path: string): Promise<void>` — upserts an entry with `lastUsedAt = now`.
- `listKnownProjects(): Promise<{ path: string; lastUsedAt: number }[]>` — reads the file (empty
  array if it doesn't exist yet).

**`SessionManager.startSession` call site becomes the single choke point** that calls
`recordProjectUsed` — both the local HTTP surface's `POST /sessions` and the new RPC
`start_session` handler call `SessionManager.startSession`, so recording happens exactly once,
correctly, regardless of which door was used to start the session.

**`SessionManager`'s single-session gate is replaced with a real concurrency cap:**
- `activeSessionId: string | undefined` is removed.
- A new constructor option `maxConcurrentSessions: number` (daemon's `main.ts` wires this from
  `COMPANION_MAX_CONCURRENT_SESSIONS`, default `3` if unset).
- `startSession` counts sessions in `this.sessions` whose `status !== 'stopped'`; if that count is
  already at `maxConcurrentSessions`, it throws (the RPC handler translates this to
  `CONCURRENT_SESSION_LIMIT`; the local HTTP handler translates it to its existing generic 500
  path, unchanged).

**Fixes a real, verified memory leak this spec would otherwise make much worse.** Today,
`SessionManager.sessions` (the `Map<string, SessionRunner>`) only ever removes an entry on a
startup failure (`session-manager.ts:45`) — a session that runs to completion and stops stays in
the map, and everything the `SessionRunner` holds onto, for the daemon process's entire lifetime.
This is rarely hit today because starting a session is a rare, manual, one-at-a-time act; this
spec turns it into a frequent, phone-driven one, so the same latent leak becomes a real one, and
hits hardest exactly the users who use the new feature most. Nothing in the codebase needs a
stopped session's runner reachable afterward — `stopSession` looks it up *before* stopping, not
after, and every other daemon-side operation (`pause`/`resume`/`respond`/`inject_prompt`) already
refuses to act on a stopped session; session history is served from the relay's durable store, not
from the daemon's memory. So the `onEvent` wrapper in `startSession` (`session-manager.ts:33-38`)
gains one line: on a `stopped` event, `this.sessions.delete(id)` alongside the existing
`activeSessionId` clear.

**New RPC handlers in `rpc-handlers.ts`**, added to `REGISTRY`:
- `list_projects` — calls `listKnownProjects()`, and if `COMPANION_PROJECTS_ROOT` is set, also
  reads its immediate subdirectories (`fs.readdir` with `withFileTypes: true`, directories only),
  merges by path (a path both in history and under the root is `'history'`, not duplicated),
  filters to paths that still exist, sorts as specified above.
- `start_session` — validates the path is in the merged known/allowed set from `list_projects`'s
  own logic (re-run, not cached — a path removed since the last list must be caught here too),
  then calls `manager.startSession(projectPath, prompt)`, translating a concurrency-cap throw and
  an invalid-path condition to their respective typed errors.

**New env vars**, documented in `packages/daemon/README.md` alongside the existing list:
- `COMPANION_PROJECTS_ROOT` — optional. A single directory; its immediate subdirectories become
  startable even with no session history. Deliberately one root, not a list — YAGNI until a real
  need for more surfaces.
- `COMPANION_MAX_CONCURRENT_SESSIONS` — optional, default `3`.
- `COMPANION_PROJECTS_FILE_PATH` — optional, default `~/.companion/daemon-projects.json`.

## Relay changes (`packages/relay/src`)

- `ConnectionHub.isDeviceConnected` (currently `private`, `hub.ts:648`) becomes a public method —
  the only visibility change needed; the logic already exists and is already correct.
- `GET /devices/daemon-status` (`server.ts:411`) response shape grows from `{ paired: boolean }`
  to, when paired, `{ paired: true; name: string; connected: boolean; pairedAt: number }` (fields
  read from the existing `store.getDaemonDeviceForUser` result plus the new
  `hub.isDeviceConnected` call); unpaired stays `{ paired: false }`. No new endpoint — this is the
  same one `SessionList.tsx`'s empty state already calls, extended rather than duplicated.

## Web changes (`packages/web/src`)

**New `api/daemon-rpc.ts`** — typed wrappers around the existing `callDaemon` (from Task 6,
already exposed through `SessionsProvider`): `listProjects()` and `startRemoteSession(projectPath,
prompt)`, returning/throwing the same way the existing `api/*.ts` files do (see `api/sessions.ts`
for the pattern), translating the RPC error codes above into `Error` messages a component can
render directly.

**New `project-color.ts`** — a pure function `colorForProject(path: string): string`, a stable
hash of the path into one of a small fixed set of Tailwind color tokens (reusing tokens already in
the app's palette, not inventing new ones) — same input always produces the same color within a
session, so a project's dot stays consistent across the dashboard without any server-side color
assignment or state.

**New `StartSessionSheet.tsx`** — a bottom sheet (not a route navigation) containing:
- A search-as-you-type project list (new `ProjectPicker.tsx` sub-component), fed by
  `listProjects()`, most-recently-used first, with a quiet badge on `source: 'configured'`
  entries that have no `lastUsedAt` ("first time").
- Once a project is picked, the same prompt-input styling as `PromptInjectionBox` ("What should
  Claude do?"), reused directly rather than re-implemented, so the moment of starting a session
  feels continuous with replying to one.
- On submit: an immediate "Starting…" state, then on success, navigation to `/sessions/:id` for
  the new session (reusing the existing `SessionDetail` route — no new detail screen needed). On
  a typed error, the sheet stays open and shows the message inline rather than losing the user's
  typed prompt (same "never discard typed input" principle as the rest of this app).

**`SessionList.tsx` redesign:**
- Sessions split into three visual tiers instead of one flat sorted list: **Needs you**
  (`waiting_permission` / `waiting_input`, oldest-waiting first — this is what `sort-sessions.ts`
  already prioritizes, so the grouping is a rendering change over already-correctly-sorted data,
  not a new sort), **Running**, and **Stopped** (collapsed under a disclosure, existing Dismiss
  action unchanged).
- Each card leads with the project's `displayName` (not the full `projectPath`, which moves to
  secondary muted text), with a `colorForProject` dot.
- A floating action button opens `StartSessionSheet`, always reachable regardless of scroll
  position or which tier is expanded.

**`SettingsScreen.tsx` fix:**
- Replaces the unconditional pairing form with three real states, driven by the extended
  `/devices/daemon-status`: **paired + connected** (daemon name, "Paired {date}", a live-status
  dot, "Unpair" as a secondary/quiet action since it's destructive and rare), **paired +
  disconnected** (same info, muted/amber status, no invented "last seen" timestamp — the app does
  not track that and should not imply it does), **not paired** (today's pairing form, now
  correctly gated behind `paired === false` instead of always rendering).

## Error handling

Every new failure path is a typed code with a real sentence, never a stall:

| Condition | Code | Where it surfaces |
|---|---|---|
| No daemon paired | `no_daemon` (existing) | Sheet shows: pair a daemon first, links to Settings |
| Daemon paired, not connected | `daemon_disconnected` (existing) | Sheet shows: daemon isn't connected right now |
| Chosen path no longer valid | `invalid_project_path` (new) | Inline in the sheet, prompt text preserved |
| At the concurrency cap | `concurrent_session_limit` (new) | Inline in the sheet: "You've reached the limit of N concurrent sessions — stop one first." |
| RPC timeout / handler threw | `timeout` / `handler_error` (existing) | Generic retry message, existing `RPC_ERROR_MESSAGES` |

## Testing strategy

- `project-store.ts`: upsert semantics (new path, existing path timestamp update), missing file
  reads as empty, malformed file is a clear error not a crash.
- `SessionManager`: cap enforcement (exactly at, one under, one over), a stopped session is
  removed from `sessions` (not just excluded from the cap count — the map itself shrinks,
  verifiable via `getSession` throwing for it afterward), existing single-session tests updated
  to reflect real concurrency.
- `rpc-handlers.ts`: `list_projects` merge/dedupe/sort logic (history + configured overlap, a
  since-deleted path excluded), `start_session` path re-validation (allowed at list time, gone by
  start time → `invalid_project_path`, not a crash).
- `hub.ts` / `server.ts`: `/devices/daemon-status` returns the extended shape when paired,
  unchanged shape when not; connected vs. disconnected reflects real hub state.
- Web: `StartSessionSheet` preserves typed prompt text on a failed submit (same pattern as
  `PromptInjectionBox`'s existing test); `SessionList` tier grouping renders sessions in the
  correct tier for each status; `SettingsScreen` renders each of the three daemon states from a
  mocked `/devices/daemon-status` response, replacing the current test that (per the bug) only
  ever exercises the always-shown form.

## Non-goals (explicitly out of scope for this spec)

- Multiple configured project roots (one root is enough until a real need for more appears).
- A "last seen" timestamp for a disconnected daemon — not tracked anywhere today; inventing one
  here would be UI implying data the app doesn't have.
- Any change to how *existing* sessions are adopted/discovered if they were started entirely
  outside Companion (e.g. a bare `claude` run with no daemon involved at all) — that remains a
  separate, not-yet-designed piece of the broader "session adoption" project this spec sits
  inside.
- Renaming or reorganizing project directories from the phone — this spec only starts sessions in
  paths that already exist; it does not manage the filesystem.
