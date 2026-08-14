# Waiting-For-Input Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify a user with a push notification, and show it clearly in the dashboard, every time Claude finishes a turn and is waiting on their reply — closing the one remaining "Claude is waiting on you" state (alongside the already-notified `permission_request`) that today produces no signal at all.

**Architecture:** A new `waiting_input` `SessionStatus` value is set whenever a `turn_complete` event arrives and cleared the instant any new activity (`assistant_text`/`tool_use`) arrives — mirrored identically in the relay's status map and the web client's copy of it, the same duplication pattern the codebase already uses for `waiting_permission`. The relay's push-notification path gains a `turn_complete` entry whose body is built from the most recently stored `assistant_text` event (a new targeted `Store` method, not a full history fetch). The web UI gets badge/sort/placeholder/callout treatment paralleling the existing `waiting_permission` treatment, plus a `SessionControls` fix so Pause doesn't wrongly disable itself in the new status.

**Tech Stack:** TypeScript, Zod (protocol schema), Drizzle ORM + Postgres (relay store), Vitest + React Testing Library (web).

## Global Constraints

- `turn_complete` notifies unconditionally, every single time — no throttling, no "only if app is backgrounded" logic.
- `STATUS_BY_EVENT_TYPE` must change identically in both `packages/relay/src/hub.ts` and `packages/web/src/use-sessions-store.ts`.
- Notification title: `"Claude is waiting for you"`. Push body: the last `assistant_text`, truncated to 140 characters with a trailing `…` if longer; falls back to `session.projectPath` if no `assistant_text` event exists for the session.
- `STATUS_LABEL['waiting_input']` = `'Waiting for you'`.
- Dashboard badge for `waiting_input`: text **"Your turn"**, class `bg-accent` — deliberately not the `bg-warning` "Needs attention" pill `waiting_permission` uses.
- Sort order: `waiting_permission` → `waiting_input` → everything else by `lastEventAt` descending.
- `PromptInjectionBox` placeholder when `waiting_input`: `"What's next?"`.
- No new daemon↔relay protocol event. `turn_complete` itself is unchanged.

---

### Task 1: Add `waiting_input` to the `SessionStatus` protocol enum

**Files:**
- Modify: `packages/protocol/src/events.ts:3-9`

**Interfaces:**
- Produces: `SessionStatus` (Zod enum + inferred type) now includes `'waiting_input'` as a valid value, used by every later task.

- [ ] **Step 1: Add the new enum value**

In `packages/protocol/src/events.ts`, change:

```ts
export const SessionStatus = z.enum([
  'running',
  'waiting_permission',
  'paused',
  'stopped',
]);
```

to:

```ts
export const SessionStatus = z.enum([
  'running',
  'waiting_permission',
  'waiting_input',
  'paused',
  'stopped',
]);
```

- [ ] **Step 2: Build and run the protocol package's tests**

Run: `npm run test -w @companion/protocol`
Expected: PASS (no existing test asserts the enum's exact member list, so nothing should break).

Run: `npm run build -w @companion/protocol`
Expected: succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/protocol/src/events.ts
git commit -m "feat(protocol): add waiting_input session status"
```

---

### Task 2: Add `Store.getLastEventOfType` to both store implementations

**Files:**
- Modify: `packages/relay/src/store.ts` (interface)
- Modify: `packages/relay/src/in-memory-store.ts`
- Modify: `packages/relay/src/postgres-store.ts`
- Modify: `packages/relay/src/store-contract-tests.ts`

**Interfaces:**
- Consumes: `StoredSessionEvent` (existing, `packages/relay/src/store.ts:39-44`: `{ seq: number; sessionId: string; event: SessionEvent; createdAt: number }`), `SessionEvent['type']` (existing protocol union of event type strings).
- Produces: `Store.getLastEventOfType(sessionId: string, type: SessionEvent['type']): Promise<StoredSessionEvent | undefined>` — the most recently appended (highest `seq`) stored event of the given `type` for that session, or `undefined` if none exists or the session is unknown. Task 3 depends on this exact signature.

- [ ] **Step 1: Add the contract test (shared by both stores)**

In `packages/relay/src/store-contract-tests.ts`, add this test inside the existing `describe(label, () => { ... })` block (anywhere alongside the other `getSessionEvents`-related tests, e.g. right after the "getSessionEvents returns an empty array for a NaN sinceSeq" test around line 262):

```ts
    it('getLastEventOfType returns the most recently appended event of that type', async () => {
      const store = await makeStore();
      await store.appendSessionEvent('sess-1', { type: 'assistant_text', sessionId: 'sess-1', text: 'first', at: 1 });
      await store.appendSessionEvent('sess-1', { type: 'tool_use', sessionId: 'sess-1', toolName: 'Bash', input: {}, at: 2 });
      await store.appendSessionEvent('sess-1', { type: 'assistant_text', sessionId: 'sess-1', text: 'second', at: 3 });

      const found = await store.getLastEventOfType('sess-1', 'assistant_text');

      expect(found?.event).toMatchObject({ type: 'assistant_text', text: 'second' });
    });

    it('getLastEventOfType returns undefined when no event of that type exists', async () => {
      const store = await makeStore();
      await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 1 });

      expect(await store.getLastEventOfType('sess-1', 'assistant_text')).toBeUndefined();
    });

    it('getLastEventOfType returns undefined for an unknown session', async () => {
      const store = await makeStore();
      expect(await store.getLastEventOfType('does-not-exist', 'assistant_text')).toBeUndefined();
    });
```

- [ ] **Step 2: Run the store tests to confirm they fail**

Run: `npm run test -w @companion/relay -- store-contract-tests`
Expected: FAIL — `store.getLastEventOfType is not a function` (both `InMemoryStore` and `PostgresStore` runs of the shared suite fail identically, since neither implements the method yet). Note: the Postgres-backed run requires the same live Neon database the rest of this project's tests already use via the gitignored `.env` at the repo root — no new setup needed, this project has no Docker/local Postgres.

- [ ] **Step 3: Add the method to the `Store` interface**

In `packages/relay/src/store.ts`, add this line to the `Store` interface, directly after `getSessionEvents` (line 78):

```ts
  getLastEventOfType(sessionId: string, type: SessionEvent['type']): Promise<StoredSessionEvent | undefined>;
```

- [ ] **Step 4: Implement it in `InMemoryStore`**

In `packages/relay/src/in-memory-store.ts`, add this method directly after `getSessionEvents` (currently the last method before the closing `}` at line 186):

```ts
  async getLastEventOfType(sessionId: string, type: SessionEvent['type']): Promise<StoredSessionEvent | undefined> {
    const list = this.events.get(sessionId) ?? [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].event.type === type) return list[i];
    }
    return undefined;
  }
```

- [ ] **Step 5: Implement it in `PostgresStore`**

In `packages/relay/src/postgres-store.ts`, change the import line (line 2) from:

```ts
import { and, asc, eq, gt, gte, isNotNull, isNull, lt } from 'drizzle-orm';
```

to:

```ts
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
```

Then add this method directly after `getSessionEvents` (currently the last method before the closing `}` at line 197):

```ts
  async getLastEventOfType(sessionId: string, type: SessionEvent['type']): Promise<StoredSessionEvent | undefined> {
    const [row] = await this.db
      .select()
      .from(sessionEvents)
      .where(and(eq(sessionEvents.sessionId, sessionId), sql`${sessionEvents.event}->>'type' = ${type}`))
      .orderBy(desc(sessionEvents.seq))
      .limit(1);
    return row;
  }
```

This filters on the `event` jsonb column's `type` key directly in Postgres (`->>'type'`) rather than fetching rows and filtering in JS, and reuses the existing `session_events_session_id_idx` index for the `sessionId` half of the `WHERE`.

- [ ] **Step 6: Run the store tests again to confirm they pass**

Run: `npm run test -w @companion/relay -- store-contract-tests`
Expected: PASS for both `InMemoryStore` and `PostgresStore` runs (6 new test results total — 3 new tests × 2 store implementations).

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/store.ts packages/relay/src/in-memory-store.ts packages/relay/src/postgres-store.ts packages/relay/src/store-contract-tests.ts
git commit -m "feat(relay): add Store.getLastEventOfType"
```

---

### Task 3: Wire `turn_complete` into `hub.ts`'s status map and push notifications

**Files:**
- Modify: `packages/relay/src/hub.ts`
- Modify: `packages/relay/src/hub.test.ts`

**Interfaces:**
- Consumes: `Store.getLastEventOfType` from Task 2.
- Produces: `STATUS_BY_EVENT_TYPE['turn_complete']` is now `'waiting_input'`; `STATUS_BY_EVENT_TYPE['assistant_text']` and `['tool_use']` are now `'running'`; `NOTIFICATION_TITLE_BY_EVENT_TYPE['turn_complete']` is `'Claude is waiting for you'`. Task 4 mirrors this same map on the web side (independently — it does not import from `hub.ts`).

- [ ] **Step 1: Update `STATUS_BY_EVENT_TYPE` and `NOTIFICATION_TITLE_BY_EVENT_TYPE`**

In `packages/relay/src/hub.ts`, change (lines 24-30):

```ts
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  turn_complete: 'running',
  stopped: 'stopped',
  error: 'stopped',
};
```

to:

```ts
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  assistant_text: 'running',
  tool_use: 'running',
  turn_complete: 'waiting_input',
  stopped: 'stopped',
  error: 'stopped',
};
```

And change (lines 38-42):

```ts
const NOTIFICATION_TITLE_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], string>> = {
  permission_request: 'Needs your permission',
  error: 'Session error',
  stopped: 'Session stopped',
};
```

to:

```ts
const NOTIFICATION_TITLE_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], string>> = {
  permission_request: 'Needs your permission',
  turn_complete: 'Claude is waiting for you',
  error: 'Session error',
  stopped: 'Session stopped',
};
```

- [ ] **Step 2: Build the push notification body from the last assistant message**

In `packages/relay/src/hub.ts`, find `notifyPush` (lines 237-262). Replace:

```ts
  private async notifyPush(userId: string, sessionId: string, eventType: SessionEvent['type']): Promise<void> {
    if (!this.pushSender) return;
    const title = NOTIFICATION_TITLE_BY_EVENT_TYPE[eventType];
    if (!title) return;
    try {
      const session = await this.store.getSession(sessionId);
      if (!session) return;
      const devices = await this.store.getDevicesForUser(userId);
      const targets = devices.filter((d) => d.type === 'browser' && d.pushSubscription);
      const payload: PushPayload = { title, body: session.projectPath, url: `/sessions/${sessionId}` };
```

with:

```ts
  private async notifyPush(userId: string, sessionId: string, eventType: SessionEvent['type']): Promise<void> {
    if (!this.pushSender) return;
    const title = NOTIFICATION_TITLE_BY_EVENT_TYPE[eventType];
    if (!title) return;
    try {
      const session = await this.store.getSession(sessionId);
      if (!session) return;
      const devices = await this.store.getDevicesForUser(userId);
      const targets = devices.filter((d) => d.type === 'browser' && d.pushSubscription);
      const body = eventType === 'turn_complete' ? await this.lastAssistantTextOrProjectPath(sessionId, session.projectPath) : session.projectPath;
      const payload: PushPayload = { title, body, url: `/sessions/${sessionId}` };
```

(The rest of the method — the `Promise.all` over `targets` — is unchanged.)

Then add this new private method directly after `notifyPush` (before `dispatchLocal`):

```ts
  private async lastAssistantTextOrProjectPath(sessionId: string, projectPath: string): Promise<string> {
    const last = await this.store.getLastEventOfType(sessionId, 'assistant_text');
    if (!last || last.event.type !== 'assistant_text') return projectPath;
    const text = last.event.text;
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }
```

(The `last.event.type !== 'assistant_text'` check is a TypeScript narrowing guard — `getLastEventOfType`'s return type is the general `StoredSessionEvent`, not one narrowed to the requested type, so this is what lets the compiler know `.text` exists on `last.event`.)

- [ ] **Step 3: Fix the existing test that used `turn_complete` as a non-qualifying event**

`packages/relay/src/hub.test.ts` around line 686-705 has a test named `'does not send a push notification for a non-qualifying event type'` that uses `turn_complete` as its example of an event that shouldn't notify. That's no longer true. Change its event from `turn_complete` to `command_failed` (a type that has never been in `NOTIFICATION_TITLE_BY_EVENT_TYPE` and still isn't) so the test continues to prove what it claims to prove:

```ts
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'command_failed', sessionId: 'sess-1', message: 'boom', at: 2 });
```

(replacing the existing `await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });` line there).

- [ ] **Step 4: Add new tests for the `turn_complete` status transition**

Add to `packages/relay/src/hub.test.ts`, near the existing status-transition test (`'updates session status based on subsequent event types and persists the event'`, around line 88):

```ts
  it('sets status to waiting_input on turn_complete, and back to running on the next assistant_text', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });
    expect((await store.getSession('sess-1'))?.status).toBe('waiting_input');

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: 'Starting the next task…',
      at: 3,
    });
    expect((await store.getSession('sess-1'))?.status).toBe('running');
  });

  it('sets status back to running on tool_use after turn_complete', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'tool_use',
      sessionId: 'sess-1',
      toolName: 'Bash',
      input: {},
      at: 3,
    });
    expect((await store.getSession('sess-1'))?.status).toBe('running');
  });
```

- [ ] **Step 5: Add tests for the `turn_complete` push notification**

Add to `packages/relay/src/hub.test.ts`, near the other push-notification tests (after the `'sends a push notification on error and stopped events'` test, around line 684):

```ts
  it('sends a push notification on turn_complete with the last assistant message as the body', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: 'Task 1 is done. Want me to continue with task 2, or something else?',
      at: 2,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 3 });

    const turnCompletePush = pushSender.sent.find((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePush?.payload).toMatchObject({
      title: 'Claude is waiting for you',
      body: 'Task 1 is done. Want me to continue with task 2, or something else?',
      url: '/sessions/sess-1',
    });
  });

  it('truncates a long assistant message to 140 characters in the push body', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });
    const longText = 'a'.repeat(200);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: longText,
      at: 2,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 3 });

    const turnCompletePush = pushSender.sent.find((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePush?.payload.body).toBe(`${'a'.repeat(140)}…`);
  });

  it('falls back to the project path in the push body when there is no assistant_text event', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });

    const turnCompletePush = pushSender.sent.find((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePush?.payload.body).toBe('/tmp/project');
  });
```

- [ ] **Step 6: Run the relay test suite**

Run: `npm run test -w @companion/relay`
Expected: PASS, including the modified and newly added `hub.test.ts` cases.

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/hub.ts packages/relay/src/hub.test.ts
git commit -m "feat(relay): notify and transition to waiting_input on turn_complete"
```

---

### Task 4: Mirror the status map on the web client

**Files:**
- Modify: `packages/web/src/use-sessions-store.ts`
- Modify: `packages/web/src/use-sessions-store.test.ts`

**Interfaces:**
- Consumes: `SessionStatus` from Task 1 (now includes `'waiting_input'`).
- Produces: `use-sessions-store.ts`'s live-event handling now sets a session's `status` to `'waiting_input'` on `turn_complete` and back to `'running'` on `assistant_text`/`tool_use`, matching Task 3's relay-side behavior exactly. `SessionSummary.status` (consumed by every Task 5/6 component) can now be `'waiting_input'`.

- [ ] **Step 1: Update the web-side `STATUS_BY_EVENT_TYPE`**

In `packages/web/src/use-sessions-store.ts`, change (lines 20-26):

```ts
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  turn_complete: 'running',
  stopped: 'stopped',
  error: 'stopped',
};
```

to:

```ts
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  assistant_text: 'running',
  tool_use: 'running',
  turn_complete: 'waiting_input',
  stopped: 'stopped',
  error: 'stopped',
};
```

- [ ] **Step 2: Add a test for the new transition**

Add to `packages/web/src/use-sessions-store.test.ts`, near the existing `"updates an existing session's status and lastEventAt from a live event"` test (around line 63):

```ts
  it('sets status to waiting_input on a live turn_complete event, and back to running on assistant_text', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      mock.emit({ sessionId: 'sess-1', seq: 2, event: { type: 'turn_complete', sessionId: 'sess-1', at: 5 } });
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === 'sess-1')).toMatchObject({ status: 'waiting_input' })
    );

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 3,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'continuing…', at: 6 },
      });
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === 'sess-1')).toMatchObject({ status: 'running' })
    );
  });
```

`sessionA` (a `SessionRecord` fixture with `id: 'sess-1'`, `status: 'running'`) and the `mockUseRelayConnection()` helper (returns `{ emit, emitUnauthorized, sendCommand, setConnected }`) are already defined at the top of `use-sessions-store.test.ts` (lines 9-37) and used exactly this way by the neighboring test — this new test reuses both as-is, no redefinition needed.

- [ ] **Step 3: Run the web test suite for this file**

Run: `npm run test -w @companion/web -- use-sessions-store`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/use-sessions-store.ts packages/web/src/use-sessions-store.test.ts
git commit -m "feat(web): mirror waiting_input status transitions from live events"
```

---

### Task 5: Dashboard UI — label, sort, badge, and the Pause-button fix

**Files:**
- Modify: `packages/web/src/SessionStatusBar.tsx`
- Modify: `packages/web/src/sort-sessions.ts`
- Modify: `packages/web/src/sort-sessions.test.ts`
- Modify: `packages/web/src/SessionList.tsx`
- Modify: `packages/web/src/SessionList.test.tsx`
- Modify: `packages/web/src/SessionControls.tsx`
- Modify: `packages/web/src/SessionControls.test.tsx`

**Interfaces:**
- Consumes: `SessionStatus` (`'waiting_input'` now valid, from Task 1), `SessionSummary.status` (from Task 4).
- Produces: no new exports — this task only changes existing component behavior/rendering that Task 6 does not depend on.

- [ ] **Step 1: Add the status label**

In `packages/web/src/SessionStatusBar.tsx`, change (lines 9-14):

```ts
export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  waiting_permission: 'Waiting for permission',
  paused: 'Paused',
  stopped: 'Stopped',
};
```

to:

```ts
export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  waiting_permission: 'Waiting for permission',
  waiting_input: 'Waiting for you',
  paused: 'Paused',
  stopped: 'Stopped',
};
```

(This `Record<SessionStatus, string>` type means TypeScript itself enforces every `SessionStatus` value has a label — omitting `waiting_input` here would already be a compile error, confirming there's nowhere else this needs adding.)

- [ ] **Step 2: Make `sortSessions` three-tier**

In `packages/web/src/sort-sessions.ts`, replace the whole file with:

```ts
import type { SessionSummary } from './use-sessions-store';

/**
 * Sessions where the user owes a response sort ahead of everything else,
 * within their own two-tier priority: a session actually blocked on a
 * permission decision (potentially time-sensitive) outranks one where
 * Claude simply finished a turn and is idle waiting for the next
 * instruction (less urgent — nothing is stuck). Within a tier, most
 * recently active first.
 */
function priority(status: SessionSummary['status']): number {
  if (status === 'waiting_permission') return 0;
  if (status === 'waiting_input') return 1;
  return 2;
}

export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const diff = priority(a.status) - priority(b.status);
    if (diff !== 0) return diff;
    return b.lastEventAt - a.lastEventAt;
  });
}
```

- [ ] **Step 3: Update `sort-sessions.test.ts`**

In `packages/web/src/sort-sessions.test.ts`, add these two tests inside the existing `describe('sortSessions', () => { ... })` block, alongside the existing `'puts waiting_permission sessions ahead of everything else'` test:

```ts
  it('puts waiting_input sessions ahead of running ones, but behind waiting_permission', () => {
    const sessions = [
      session({ id: 'a', status: 'running', lastEventAt: 100 }),
      session({ id: 'b', status: 'waiting_input', lastEventAt: 1 }),
      session({ id: 'c', status: 'waiting_permission', lastEventAt: 1 }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts within the waiting_input tier by lastEventAt descending', () => {
    const sessions = [
      session({ id: 'old', status: 'waiting_input', lastEventAt: 1 }),
      session({ id: 'new', status: 'waiting_input', lastEventAt: 100 }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['new', 'old']);
  });
```

- [ ] **Step 4: Add the "Your turn" badge**

In `packages/web/src/SessionList.tsx`, change (lines 98-103):

```tsx
                <p className="font-medium">
                  {STATUS_LABEL[session.status]}
                  {session.status === 'waiting_permission' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warning">Needs attention</span>
                  )}
                </p>
```

to:

```tsx
                <p className="font-medium">
                  {STATUS_LABEL[session.status]}
                  {session.status === 'waiting_permission' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warning">Needs attention</span>
                  )}
                  {session.status === 'waiting_input' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-accent">Your turn</span>
                  )}
                </p>
```

- [ ] **Step 5: Add the `SessionList` test for the new badge**

In `packages/web/src/SessionList.test.tsx`, add this test near the existing `'shows the attention badge for a waiting_permission session'` test (around line 100):

```tsx
  it('shows the "Your turn" badge for a waiting_input session', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'waiting_input', lastEventAt: 1 }],
    });
    renderList();
    expect(screen.getByText('Your turn')).toBeInTheDocument();
  });
```

- [ ] **Step 6: Fix `SessionControls` so Pause isn't wrongly disabled**

`canPause` in `packages/web/src/SessionControls.tsx` currently checks `status === 'running'` only (line 10). A session in `waiting_input` is just as pausable as one in `running` — nothing is in flight — so leaving this unchanged would make Pause incorrectly disable itself the moment a turn completes. Change:

```ts
  const canPause = status === 'running';
```

to:

```ts
  const canPause = status === 'running' || status === 'waiting_input';
```

- [ ] **Step 7: Add the `SessionControls` test for the fix**

In `packages/web/src/SessionControls.test.tsx`, add this test near the existing `'enables only Pause and Stop when running'` test:

```tsx
  it('enables Pause and Stop when waiting_input, same as running', () => {
    render(<SessionControls sessionId="sess-1" status="waiting_input" onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });
```

- [ ] **Step 8: Run the web test suite**

Run: `npm run test -w @companion/web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/SessionStatusBar.tsx packages/web/src/sort-sessions.ts packages/web/src/sort-sessions.test.ts packages/web/src/SessionList.tsx packages/web/src/SessionList.test.tsx packages/web/src/SessionControls.tsx packages/web/src/SessionControls.test.tsx
git commit -m "feat(web): dashboard badge, sort tier, and pause-button fix for waiting_input"
```

---

### Task 6: Session-detail UI — contextual placeholder and last-message callout

**Files:**
- Modify: `packages/web/src/PromptInjectionBox.tsx`
- Modify: `packages/web/src/PromptInjectionBox.test.tsx`
- Modify: `packages/web/src/SessionDetail.tsx`
- Modify: `packages/web/src/SessionDetail.test.tsx`

**Interfaces:**
- Consumes: `SessionStatus` (Task 1), `SessionSummary.status` (Task 4), `SessionEvent` (existing protocol type — this task reads the `events` array already held in `SessionDetail`'s local state, no new fetch).
- Produces: `PromptInjectionBox` gains an optional `placeholder?: string` prop (falls back to its current default text when omitted, so no caller besides `SessionDetail` needs to change).

- [ ] **Step 1: Give `PromptInjectionBox` a `placeholder` prop**

In `packages/web/src/PromptInjectionBox.tsx`, change:

```tsx
export interface PromptInjectionBoxProps {
  sessionId: string;
  disabled: boolean;
  onSend: (command: Command) => void;
}

export default function PromptInjectionBox({ sessionId, disabled, onSend }: PromptInjectionBoxProps) {
```

to:

```tsx
export interface PromptInjectionBoxProps {
  sessionId: string;
  disabled: boolean;
  placeholder?: string;
  onSend: (command: Command) => void;
}

export default function PromptInjectionBox({ sessionId, disabled, placeholder, onSend }: PromptInjectionBoxProps) {
```

And change the `<input>`'s `placeholder` attribute from:

```tsx
        placeholder={disabled ? 'Waiting for a permission response…' : 'Send a follow-up prompt'}
```

to:

```tsx
        placeholder={disabled ? 'Waiting for a permission response…' : (placeholder ?? 'Send a follow-up prompt')}
```

- [ ] **Step 2: Add a test for the new prop**

`packages/web/src/PromptInjectionBox.test.tsx` currently ends with this closing test and the `describe` block's closing brace:

```tsx
  it('disables the input and button while waiting for permission', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled onSend={() => {}} />);

    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });
});
```

Insert these two new tests directly before that closing `});` (i.e. after the `'disables the input and button while waiting for permission'` test, still inside the `describe('PromptInjectionBox', ...)` block):

```tsx
  it('uses the placeholder prop when provided and not disabled', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} placeholder="What's next?" onSend={() => {}} />);
    expect(screen.getByPlaceholderText("What's next?")).toBeInTheDocument();
  });

  it('falls back to the default placeholder when none is provided', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={() => {}} />);
    expect(screen.getByPlaceholderText('Send a follow-up prompt')).toBeInTheDocument();
  });
```

- [ ] **Step 3: Pass the contextual placeholder and add the last-message callout in `SessionDetail`**

In `packages/web/src/SessionDetail.tsx`, add this helper function at the bottom of the file, alongside the existing `findPendingPermissionRequest` function:

```ts
function findLastAssistantText(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'assistant_text') return event.text;
  }
  return undefined;
}
```

Then, inside the component body, add this line directly after the existing `const permissionRequest = findPendingPermissionRequest(events);` (line 148):

```ts
  const lastAssistantText = summary.status === 'waiting_input' ? findLastAssistantText(events) : undefined;
```

Then change the `PromptInjectionBox` usage (lines 175-179) from:

```tsx
      <PromptInjectionBox
        sessionId={sessionId}
        disabled={summary.status === 'waiting_permission'}
        onSend={handleSend}
      />
```

to:

```tsx
      {lastAssistantText && (
        <div className="bg-panel rounded-md px-4 py-3">
          <p className="text-xs font-medium text-ink-muted mb-1">Claude is waiting for your reply</p>
          <p className="text-sm">{lastAssistantText}</p>
        </div>
      )}

      <PromptInjectionBox
        sessionId={sessionId}
        disabled={summary.status === 'waiting_permission'}
        placeholder={summary.status === 'waiting_input' ? "What's next?" : undefined}
        onSend={handleSend}
      />
```

- [ ] **Step 4: Add `SessionDetail` tests**

`packages/web/src/SessionDetail.test.tsx` defines a module-level `activeSummary: SessionSummary` fixture (status `'running'`) and a `mockSessions(overrides)` helper that accepts a `sessions` override to replace it — this is the same mechanism to reuse here, passing a summary with `status: 'waiting_input'`. Add these two tests inside the `describe('SessionDetail', ...)` block, alongside the existing `'loads and renders the session history on mount'` test:

```tsx
  it('shows the last-assistant-message callout and contextual placeholder when waiting_input', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'Task 1 is done — want task 2 next?', at: 1 },
        createdAt: 1,
      },
      {
        seq: 2,
        sessionId: 'sess-1',
        event: { type: 'turn_complete', sessionId: 'sess-1', at: 2 },
        createdAt: 2,
      },
    ]);
    mockSessions({ sessions: [{ ...activeSummary, status: 'waiting_input' }] });

    renderDetail();

    expect(await screen.findByText('Claude is waiting for your reply')).toBeInTheDocument();
    expect(screen.getByText('Task 1 is done — want task 2 next?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What's next?")).toBeInTheDocument();
  });

  it('does not show the waiting_input callout when running', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'still working', at: 1 },
        createdAt: 1,
      },
    ]);
    mockSessions();

    renderDetail();

    await screen.findByText('Running');
    expect(screen.queryByText('Claude is waiting for your reply')).not.toBeInTheDocument();
  });
```

- [ ] **Step 5: Run the web test suite**

Run: `npm run test -w @companion/web`
Expected: PASS.

- [ ] **Step 6: Run the full monorepo test suite as a final check**

Run: `npm test`
Expected: PASS across all four packages (protocol, relay, daemon, web).

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/PromptInjectionBox.tsx packages/web/src/PromptInjectionBox.test.tsx packages/web/src/SessionDetail.tsx packages/web/src/SessionDetail.test.tsx
git commit -m "feat(web): contextual placeholder and last-message callout for waiting_input"
```
