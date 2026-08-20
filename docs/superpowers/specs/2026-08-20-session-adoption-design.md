# Session Adoption — Design Spec

**Status:** Approved for planning (design conversation 2026-08-20).

## Goal

Let a user bring a Claude Code session that was started **entirely outside Companion** — a
bare `claude` CLI run in a terminal, or a session started from an IDE — onto their phone, so
they don't lose access to work just because it wasn't started through the app.

This is distinct from **remote session start** (shipped 2026-08-19, commit `c5f349a`), which
creates brand-new daemon-owned sessions from the phone. Adoption discovers and picks up
sessions the daemon never spawned in the first place.

## Why this isn't literal live-attach

The `@anthropic-ai/claude-agent-sdk` (confirmed by reading `sdk.d.ts` directly, the version
vendored in this repo) has no concept of attaching to another process's live, in-flight
session. There is no live-process handle, no read-only observer mode, and `SDKSessionInfo`
(the shape `listSessions()` returns) carries no pid/lock/liveness field — only
`lastModified`, a timestamp, which is not a reliable liveness signal.

What the SDK does support:
- `listSessions({dir})` — enumerates every session Claude Code has ever persisted to disk for
  a project directory, from any source (bare CLI, IDE, or a prior Companion session),
  returning `{sessionId, summary, firstPrompt, lastModified, cwd, ...}` per session (no
  message content).
- `getSessionMessages(sessionId, {dir, limit, offset})` — reads a session's full transcript
  from its JSONL file.
- `query({options: {resume: sessionId, forkSession: true, sessionId: newId}})` — loads a
  session's history and continues it under a **new**, caller-chosen session ID, without ever
  writing to the original transcript file again.

Resuming a session ID that's still held open by another live process (e.g. a terminal window
still running) would race two processes writing to the same file — a real, undocumented
corruption risk. `forkSession: true` avoids this entirely: the daemon never touches the
original file, regardless of whether it's still live elsewhere. This is the safe primitive
adoption is built on. The tradeoff, accepted as inherent to how the SDK works, not a shortcut
this design is taking: the original session (in its terminal, if still open) and the newly
adopted one on the phone become independent, diverging conversations from the fork point
onward — there's no mechanism to keep them merged, and building one would mean racing two
writers on one file, which is the exact hazard being avoided.

## Architecture

```
Phone picks a project (existing StartSessionSheet flow)
  → daemon lists discoverable sessions for that project (if any)
  → phone shows them alongside "start fresh" (always available)
  → user picks one → daemon forks it into a new Companion-owned session
  → from this point on, it is an ordinary Companion session:
    same SessionManager/SessionRunner, same event stream, same relay
    storage, same push notifications, same multi-device sync.
```

Everything downstream of the fork is existing machinery. The only new pieces are: discovery,
the fork step itself, one-time history delivery, and the web UI to surface both.

## Daemon changes

### New RPC methods (registered in `rpc-handlers.ts`'s `REGISTRY`, mirroring `list_projects`/`start_session`'s existing shape and validation discipline exactly)

**`list_discoverable_sessions`**
- Params: `{ projectPath: string }`. Validated against `resolveKnownProjects` exactly like
  `start_session` validates today — `INVALID_PROJECT_PATH` if not a known/existing path.
- Calls the SDK's `listSessions({ dir: projectPath, includeProgrammatic: false })`.
  `includeProgrammatic: false` is the SDK's own documented flag for excluding
  daemon/SDK-spawned sessions — this is what keeps the daemon's own already-Companion-owned
  sessions from ever appearing back to the user as "discoverable." No extra filtering logic
  needed on the daemon's side beyond passing this flag.
- Returns an array of lightweight entries (metadata only, no message content):
  ```typescript
  interface DiscoverableSessionEntry {
    sessionId: string;
    summary: string;        // SDK's own title/summary field
    firstPrompt: string | undefined;
    lastModified: number;   // epoch ms
  }
  ```
- No new state, no persistence — this is a live, on-demand filesystem scan via the SDK, same
  cost profile as `resolveKnownProjects`'s existing `readdir`/`stat` calls.

**`adopt_session`**
- Params: `{ projectPath: string, sessionId: string }`.
- Re-validates `projectPath` (`INVALID_PROJECT_PATH` on failure) and re-validates that
  `sessionId` still appears in a fresh `listSessions({dir: projectPath, includeProgrammatic:
  false})` call — never trusts an earlier `list_discoverable_sessions` response, same
  "re-derive, don't cache" discipline `start_session` already applies to project paths. If not
  found: new error code `SESSION_NOT_FOUND` (see below).
- Checks the existing concurrency cap (`SessionManager`'s `maxConcurrentSessions`) exactly as
  `start_session` does — adopting consumes a session slot the same way starting one does.
  Cap-exceeded still maps to the existing `CONCURRENT_SESSION_LIMIT`.
- Calls `SessionManager.adoptSession(projectPath, sessionId)` (new method, described below).
- Returns `{ id: string, status: string }` — same shape as `start_session`'s response.

### New error code (`packages/protocol/src/rpc-errors.ts`)

```typescript
/** The `adopt_session` caller gave a `sessionId` that is no longer discoverable under the
 * given `projectPath` — never existed there, or existed but the underlying transcript file
 * has since been deleted or moved between the list call and the adopt call. One code covers
 * both causes, same reasoning as INVALID_PROJECT_PATH: the remedy is identical (re-list, pick
 * again). */
SESSION_NOT_FOUND: 'session_not_found',
```

Add the matching entry to `packages/web/src/relay-connection.ts`'s `RPC_ERROR_MESSAGES`
exhaustive map (the switch is exhaustive over `RpcErrorCode`, so this is required for the
project to typecheck, not optional polish) — message text: `"That session isn't available to
adopt anymore. Try picking another."`

### `SessionManager` (`session-manager.ts`)

New method `adoptSession(projectPath: string, originalSessionId: string): SessionRunner`,
structurally parallel to `startSession`: same cap check (same `isCapExceeded` marker
convention), same `id = randomUUID()`, same `sessions.set(id, runner)` / stopped-session
cleanup wiring, same fire-and-forget `recordProjectUsed` call (adopting a session in a project
counts as using that project, same as starting one). The only difference: it calls
`runner.adopt(originalSessionId)` instead of `runner.start(prompt)`.

### `SessionRunner` (`session-runner.ts`)

New method `adopt(originalSessionId: string): void`, parallel to `start(initialPrompt)`:
- Calls `this.queryFn({ prompt: this.inputQueue, options: { cwd: this.projectPath, canUseTool:
  (request) => this.handlePermissionRequest(request), sessionId: this.id, resumeSessionId:
  originalSessionId } })` — identical to `start()`'s own call, with the two new fields added
  and **no initial prompt pushed to `inputQueue`**. The user lands in the session free to type whenever, exactly like walking up
  to an already-going conversation rather than being forced to restate something to kick it
  off.
- Emits `session_started` exactly as `start()` does (same event, same fields) — an adopted
  session is a `session_started` from the mobile app's point of view; it doesn't need a
  separate top-level status.
- Immediately after, fetches the original transcript via
  `getSessionMessages(originalSessionId, { dir: projectPath })` — **no `limit`/`offset`
  passed**. The SDK's own doc comment for `getSessionMessages` says it returns messages "in
  chronological order" and `limit`/`offset` are plain array slicing from the *start*, so
  passing `limit: 50` would return the oldest 50 messages of a long conversation, not the most
  recent ones — the opposite of what's useful here. Instead: fetch the full array, then take
  the most recent `HISTORY_MESSAGE_CAP` (= 50, exact value) via `messages.slice(-50)` in the
  daemon's own code, with `truncated = messages.length > 50` computed from the real
  pre-slice length.

  Maps the SDK's messages into a minimal shape (protocol-owned, not the SDK's own message
  type, to avoid leaking SDK-internal shapes into the shared protocol package):
  ```typescript
  interface AdoptedHistoryMessage {
    role: 'user' | 'assistant';
    text: string;
  }
  ```
  **No `at`/timestamp field** — confirmed by reading the SDK's `SessionMessage` type
  (`sdk.d.ts`) directly: it carries no per-message timestamp (`type`, `uuid`, `session_id`,
  `message: unknown`, `parent_tool_use_id`, `parent_agent_id` only), so a per-message `at`
  cannot be honestly sourced. This isn't a loss for the UI as designed: these messages render
  once, together, inside a single "Prior conversation" block in the array's own chronological
  order (which `getSessionMessages` already guarantees) — they are never interleaved on a
  timeline with live events, so no timestamp is actually needed to render them correctly.
  Only `type === 'user' | 'assistant'` entries are mapped (system entries dropped); each
  entry's `message` field is `unknown` on the wire, exactly like the live stream's `SDKMessage`
  union, so extract text the same defensive way `real-agent-sdk.ts`'s existing
  `translateSdkMessage` already does for live messages: treat `message.message` as
  `{content?: unknown}`, filter `content` (if an array) to blocks where
  `block.type === 'text'`, join their `text` fields. An entry that yields no text after
  extraction (e.g. a turn that was pure tool-use) is skipped, not emitted as a blank line.

  Non-text content (tool calls/results) in the historical transcript is dropped for this
  summary — the goal is "enough context to recognize what was being worked on," not a
  byte-perfect replay. Emits one `adopted_history` event (new `SessionEvent` variant, see
  below) carrying this array, plus a `truncated: boolean` flag (true when the original
  transcript had more than `HISTORY_MESSAGE_CAP` messages, so the UI can say so honestly
  rather than silently showing a partial history as if it were complete).
- Proceeds into the existing `drainMessages()` loop exactly as `start()` does — everything
  after this point (permission requests, turn completion, pause, stop) is completely
  unchanged, shared code.

### `agent-sdk-port.ts` / `real-agent-sdk.ts`

`AgentQueryOptions` gains two new optional fields:
```typescript
sessionId?: string;
resumeSessionId?: string;
```
`realQueryFn` passes them through to the SDK's `query()` call as `sessionId: options.sessionId,
resume: options.resumeSessionId, forkSession: options.resumeSessionId ? true : undefined` —
`forkSession` is only ever set when `resumeSessionId` is present, so a normal fresh
`start()` call (which passes neither) is completely unaffected; existing behavior for
non-adopted sessions is untouched.

## Protocol changes (`packages/protocol/src/events.ts`)

One new variant added to the `SessionEvent` discriminated union:
```typescript
z.object({
  type: z.literal('adopted_history'),
  sessionId: z.string(),
  originalSessionId: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      text: z.string(),
    })
  ),
  truncated: z.boolean(),
  at: z.number(),
}),
```
(`at` here is the *event's* own timestamp — when the daemon emitted this adoption summary —
matching every other `SessionEvent` variant's convention. It is not a per-message timestamp;
see the daemon-changes section above for why individual messages don't carry one.)

## Relay changes

**None required.** Confirmed by reading `packages/relay/src/db/schema.ts:123` — events are
stored as a single `jsonb` column typed to the `SessionEvent` union, not a per-type rigid
schema — and `hub.ts`'s `STATUS_BY_EVENT_TYPE` / `NOTIFICATION_TITLE_BY_EVENT_TYPE` maps are
both `Partial<Record<SessionEvent['type'], ...>>`. A new event type absent from those maps is
automatically a safe no-op: it doesn't change session status (status stays whatever
`session_started` set) and doesn't trigger a push notification (correct — a one-time
historical dump on adoption isn't something that needs to interrupt the user). Widening the
protocol union is the only change; the relay's storage/routing/notification code needs zero
edits.

## Web changes

### `StartSessionSheet.tsx`

The existing phase machine (`loading-projects | picking | prompting`, per the file as shipped
in remote-session-start) gains one new phase between picking a project and prompting:

After `handleSelect(project)`, instead of moving straight to `prompting`, call
`callDaemon('list_discoverable_sessions', { projectPath: project.path })`.
- Empty result (the common case — most projects have no external sessions): proceed straight
  to the existing `prompting` phase, unchanged. Zero added UX for the common path.
- Non-empty result: new phase `choosing-session`, showing each discovered session (summary,
  first-prompt snippet, "last active `<relative time>` ago" computed client-side from
  `lastModified` — no invented data, this is a real field from the SDK) as a tappable row,
  with a persistent, equally-visible "Start a new session instead" option — discovery must
  never hide or bury the existing fresh-start path.
- Tapping a discovered row calls `callDaemon('adopt_session', { projectPath, sessionId })`
  (no prompt required) and on success calls `onStarted(id)` exactly like a fresh start does —
  same navigation to `/sessions/:id`.
- A `list_discoverable_sessions` failure (any RPC error) fails toward the existing `prompting`
  phase silently — discovery is a convenience, not a required step, and its failure must never
  block starting a fresh session. (Contrast with `StartSessionSheet`'s own `list_projects`
  load failure, which does surface as a blocking error — that one is required data, this one
  isn't.)

### `ActivityFeed.tsx`

New rendering case for `adopted_history` events: a visually muted, collapsible block ("Prior
conversation") above the live event stream, rendering each `AdoptedHistoryMessage` as a
simple role-labeled line (not the full rich rendering live messages get — tool use, permission
requests, etc. don't apply to historical summary entries). **Expanded by default** — the whole
point is to show why this session matters without an extra tap; collapsing is there for users
who want to scroll past it on a session they've already reviewed. When `truncated: true`, the
block's header says so explicitly (e.g. "Showing the most recent 50 messages of a longer
conversation") — no silent truncation.

## Multi-device access (documented behavior, not new work)

Once a session is adopted (forked), it is an ordinary Companion session — reachable from
**any** device signed into the same account through Companion's web app, including a laptop
browser, with zero adoption-specific code: the web app is already a normal PWA, not
phone-only, and every session already syncs through the relay to every connected device.

Going back to a **raw terminal** for that same (now-forked) session while the daemon holds it
open is unsafe for the identical reason attaching to a live session was unsafe in the first
place — a second process would race the daemon's own writes to that transcript. This becomes
safe the moment the session is stopped from the app (`SessionRunner.stop()`, already-existing
behavior, calls `agentQuery.close()`): once nothing holds the transcript open, `claude --resume
<that-id>` from any terminal is fine. No new mechanism is needed for this — it is a direct,
already-true consequence of `stop()`'s existing behavior, not a feature this project builds.

The **original** session (the terminal it was adopted from, if still open) is untouched by
adoption and keeps running independently for its own lifetime. It does not merge back with the
adopted copy — continuing to type into it after adoption continues a separate, diverged
conversation.

## Non-goals / accepted simplifications

- No live-attach to an in-flight external process (mechanically impossible with this SDK —
  see above).
- No liveness detection ("is the original terminal still open right now") — forking makes this
  unnecessary for safety; the UI shows `lastModified` for the user's own judgment, nothing
  more is claimed.
- No dedup/bookkeeping for sessions adopted more than once — re-adopting the same original
  transcript just creates another independent fork. Harmless, not tracked in v1.
- No import of tool-call/tool-result detail into the historical summary — text-only, capped at
  50 messages.
- No new relay surface, no new database migration.

## Global constraints for the implementation plan

- `HISTORY_MESSAGE_CAP = 50` (exact value, not a placeholder).
- `includeProgrammatic: false` must be passed on every `listSessions` call this feature makes
  — omitting it would leak the daemon's own already-adopted/started sessions back into the
  discovery list.
- `forkSession` must only ever be set `true` when `resumeSessionId` is present — never
  unconditionally — so normal fresh-start sessions are provably unaffected by this feature.
- `SESSION_NOT_FOUND` must be added to `RPC_ERROR_MESSAGES`'s exhaustive switch in
  `relay-connection.ts` or the web package fails to typecheck (mirrors how `Task 1` of
  remote-session-start's plan required the same for its new codes).
- Discovery (`list_discoverable_sessions`) is scoped to the daemon's own known-projects list
  (via `resolveKnownProjects`'s existing validation) — never an arbitrary global filesystem
  scan across every project Claude Code has ever touched on the machine.
