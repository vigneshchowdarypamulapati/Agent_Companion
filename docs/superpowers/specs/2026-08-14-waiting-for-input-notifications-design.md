# "Claude Is Waiting For You" Notifications — Design

## Problem

Claude Companion already pushes a notification for three daemon-emitted
events: `permission_request`, `error`, `stopped`
(`packages/relay/src/hub.ts`'s `NOTIFICATION_TITLE_BY_EVENT_TYPE`). It does
**not** notify when Claude simply finishes a turn and is waiting on the
user's next reply, suggestion, or instruction — the exact moment in a
multi-task session where Claude says "task 1 done — want me to continue
with task 2, or is there something else?" and then goes idle. A user away
from their machine gets no signal that it's their turn, even though the
mechanism to reply from anywhere already exists (`PromptInjectionBox` →
`inject_prompt` command, already unblocked whenever a session isn't
`waiting_permission`).

Across the protocol's current event set
(`packages/protocol/src/events.ts`), the only two states where Claude is
genuinely waiting on the user are `permission_request` (already notified)
and the daemon's `turn_complete` event (not notified). Wiring up
`turn_complete` closes the gap completely — there is no other "waiting on
you" state left uncovered.

Beyond the missing notification, the dashboard has no visual way to tell
"Claude is actively working" apart from "Claude finished and is waiting for
you" — both currently render as the generic `running` status. This matters
even with the app open, not just for the push case.

## Non-Goals

- No throttling, deduplication, or "only if the app isn't focused" logic —
  every `turn_complete` notifies, unconditionally, matching how
  `permission_request`/`error`/`stopped` already behave with no throttling
  of their own.
- No changes to the reply mechanism itself (`PromptInjectionBox`,
  `inject_prompt`) — it already works for this case.
- No new daemon-to-relay protocol surface beyond the `SessionStatus` enum
  gaining one value. `turn_complete` itself is unchanged; it still carries
  no text — the design reads the preceding stored `assistant_text` event
  instead of altering the SDK message translation.

## Architecture

### 1. New session status: `waiting_input`

`packages/protocol/src/events.ts`'s `SessionStatus` enum gains
`'waiting_input'`, alongside the existing `running` / `waiting_permission`
/ `paused` / `stopped`.

Both places that map session events to a status — `hub.ts`'s
`STATUS_BY_EVENT_TYPE` and `use-sessions-store.ts`'s duplicate of it (a
deliberate, comment-documented duplication already in the codebase) —
change identically:

- `turn_complete` now maps to `waiting_input` (was `running`).
- `assistant_text` and `tool_use` are newly added, both mapping to
  `running`.

The second change is load-bearing, not cosmetic: without it, a session
would get stuck showing `waiting_input` for the entire time Claude is
actively working on a follow-up prompt, because `inject_prompt` is a
*command* (routed via `routeFromBrowser`, which never touches session
status) and the daemon's first events in response are `assistant_text`/
`tool_use` — currently unmapped, so status would never leave
`waiting_input` until the next `turn_complete`. Mapping both to `running`
makes the transition self-healing: the instant Claude produces any new
activity, status flips back to `running`; the instant a turn ends, it
flips to `waiting_input`. No new event type is needed.

### 2. Notification body carries Claude's actual message

`notifyPush` (`hub.ts`) currently sends `session.projectPath` as the body
for every event type — adequate for "session stopped," useless for "what
is Claude asking me." The SDK's `result` message (the thing that produces
`turn_complete`) carries no text of its own; Claude's actual closing
message was already emitted and stored moments earlier as a separate
`assistant_text` event. So the notification body is built by looking that
up.

Rather than fetching a session's entire event history to find the last one
(the existing `getSessionEvents` has no "most recent" mode, and a session
can accumulate many events), `Store` gains one targeted method:

```ts
getLastEventOfType(sessionId: string, type: SessionEvent['type']): Promise<StoredSessionEvent | undefined>
```

Implemented in `PostgresStore` as a single `ORDER BY seq DESC LIMIT 1`
query filtered on the event's JSON `type` field, and in `InMemoryStore` by
scanning its in-memory array backwards. Added to the shared
`store-contract-tests.ts` suite so both implementations are verified
against the same behavior.

`notifyPush`, only when `eventType === 'turn_complete'` and a `pushSender`
is configured (matching its existing best-effort, no-op-if-unconfigured
posture), calls `getLastEventOfType(sessionId, 'assistant_text')` and uses
its text as the body, truncated to ~140 characters with an ellipsis if
longer. Falls back to `session.projectPath` if no `assistant_text` event
exists (e.g. a turn that ended abruptly). Title: **"Claude is waiting for
you"**, added to `NOTIFICATION_TITLE_BY_EVENT_TYPE` alongside the existing
three.

### 3. Dashboard and session-detail UI

- `SessionStatusBar.tsx`'s `STATUS_LABEL` gains
  `waiting_input: 'Waiting for you'`.
- `sort-sessions.ts` becomes a three-tier sort instead of two:
  `waiting_permission` (something is actually blocked — most urgent) →
  `waiting_input` (Claude is idle, your turn, less urgent) → everything
  else by `lastEventAt` descending. Permission requests keep top priority
  since they can be time-sensitive in a way an idle "what's next?" isn't.
- `SessionList.tsx`'s badge logic extends to `waiting_input`, but
  deliberately does **not** reuse the amber `bg-warning` "Needs attention"
  pill — that color communicates "something's blocked," which overstates
  an idle-and-waiting state. `waiting_input` gets its own calmer pill:
  `bg-accent`, text **"Your turn."**
- `SessionDetail.tsx` / `PromptInjectionBox.tsx`: the input's placeholder
  becomes contextual — **"What's next?"** when `status === 'waiting_input'`
  (still just `"Send a follow-up prompt"` when `running`, unchanged when
  disabled for `waiting_permission`).
- `SessionDetail.tsx` gains a small callout, shown only when
  `status === 'waiting_input'`, directly above `PromptInjectionBox`,
  displaying the same last-`assistant_text` message the push notification
  referenced (full text, not truncated — it's already loaded as part of
  the session's fetched event history, no extra request needed). This
  closes the loop: push notification → tap → land on the session → see
  exactly what Claude asked, right above the box you reply in.

## Data Flow

1. Claude finishes responding → SDK emits a `result` message → daemon's
   `translateSdkMessage` yields `{ type: 'turn_complete' }` (unchanged).
2. `SessionRunner` sends the event to the relay; `routeFromDaemon` looks up
   `STATUS_BY_EVENT_TYPE['turn_complete']` → `waiting_input`, persists it
   via `updateSessionStatus`, appends the event, publishes it over pubsub
   to connected browsers, then calls `notifyPush`.
3. `notifyPush` sees `turn_complete` has a notification title, fetches the
   last `assistant_text` event via `getLastEventOfType`, builds the
   truncated body, and sends a push to every one of the user's browser
   devices with a stored subscription — same fan-out as today.
4. A connected browser gets the live event over the WebSocket and updates
   `SessionSummary.status` to `waiting_input` immediately (via the mirrored
   client-side `STATUS_BY_EVENT_TYPE`); the dashboard badge and sort order
   update without a page reload. `SessionDetail`, if open, shows the
   "What's next?" placeholder and the last-message callout.
5. A backgrounded/locked phone gets the OS push: "Claude is waiting for
   you" / Claude's actual message. Tapping it opens `/sessions/:id`,
   landing exactly on the reply flow described above.
6. User sends a follow-up. `inject_prompt` command flows through
   `routeFromBrowser` unchanged (no status touch). The daemon resumes; its
   first `assistant_text`/`tool_use` event maps back to `running`,
   clearing `waiting_input` everywhere without any special-case code.

## Testing Strategy

- **Protocol:** `SessionStatus` enum extension is a one-line change,
  covered indirectly by every test that already exercises the enum.
- **Store:** contract tests for `getLastEventOfType` — returns the most
  recent event of a given type, returns `undefined` when none exists,
  returns `undefined` for an unknown session — run against both
  `InMemoryStore` and `PostgresStore` via the shared suite.
- **Relay (`hub.ts`):** unit tests that `routeFromDaemon` with a
  `turn_complete` event sets status to `waiting_input`, then that a
  subsequent `assistant_text` or `tool_use` event sets it back to
  `running`. A `notifyPush` test asserting the push body is built from the
  last stored `assistant_text` (with a fallback-to-`projectPath` test for
  when none exists), and a title test for `turn_complete` alongside the
  existing three.
- **Web:** `sort-sessions.test.ts` extended for the three-tier order.
  `SessionList.test.tsx` extended for the "Your turn" pill (distinct from
  the existing "Needs attention" test). `SessionStatusBar` label test.
  `PromptInjectionBox`/`SessionDetail` tests for the contextual placeholder
  and the last-message callout appearing only in `waiting_input`.

## Global Constraints

- `turn_complete` notifies unconditionally, every time, with no throttling
  — matches existing `permission_request`/`error`/`stopped` behavior.
- `STATUS_BY_EVENT_TYPE` must be changed identically in both
  `packages/relay/src/hub.ts` and `packages/web/src/use-sessions-store.ts`
  (existing duplication, documented in a comment on the web-side copy).
- Notification title: `"Claude is waiting for you"`. Badge text:
  `"Your turn"` on a `bg-accent` pill (not `bg-warning`). Placeholder text:
  `"What's next?"`.
- Push body truncated to ~140 characters with an ellipsis; falls back to
  `session.projectPath` when no `assistant_text` event is found.
- No throttling/dedup logic, no "only when app is backgrounded" logic — out
  of scope per Non-Goals.
