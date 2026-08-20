# Session Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user discover a Claude Code session that was started entirely outside Companion
(a bare `claude` CLI run, an IDE session) and pick it up on their phone — forking it into a new,
Companion-owned session that continues under the app's normal event streaming, push
notifications, and multi-device sync, without ever touching the original transcript file.

**Architecture:** The daemon gains two new RPC methods (`list_discoverable_sessions`,
`adopt_session`) that call the Claude Agent SDK's own `listSessions`/`getSessionMessages`/
`query({resume, forkSession})` primitives — no live-process attachment exists or is attempted.
Once forked, an adopted session is indistinguishable from a freshly-started one to every
downstream layer (`SessionManager`, the relay, the web app) except for one new
`adopted_history` event carrying a one-time snapshot of the prior conversation. The relay
requires **zero code changes** — its event storage is a generic `jsonb` column typed to the
`SessionEvent` union, and its status/notification logic only reacts to event types it
explicitly lists, so an unlisted type is automatically inert.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (`listSessions`,
`getSessionMessages`, `query`'s `resume`/`forkSession`/`sessionId` options), Zod (protocol
schemas), React 19 (web), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-session-adoption-design.md`

**Baseline test count (measured 2026-08-20, current master via this branch):** daemon 153
passed + 1 skipped, protocol 64 passed, relay 306 passed (one pre-existing, documented flake in
`postgres-store.test.ts`/`schema.test.ts` — a `beforeAll` hook timeout against the remote test
database under load; unrelated to this feature, do not attempt to fix it), web 242 passed. 765
total.

## Global Constraints

- `HISTORY_MESSAGE_CAP = 50` (exact value). Applied by slicing the **full** result of
  `getSessionMessages(sessionId, { dir })` (called with no `limit`/`offset`) down to
  `messages.slice(-50)` — passing `limit: 50` directly would return the *oldest* 50 messages
  (the SDK returns messages in chronological order, and `limit`/`offset` slice from the start),
  which is backwards from what's useful here.
- `AdoptedHistoryMessage` carries **no timestamp field** (`{role, text}` only). The SDK's
  `SessionMessage` type (confirmed by reading `sdk.d.ts` directly) has no per-message
  timestamp, so one cannot be honestly sourced — and none is needed, since these messages
  render once, in the array's own guaranteed chronological order, inside a single "Prior
  conversation" block, never interleaved on a timeline with live events.
- `includeProgrammatic: false` must be passed on every `listSessions` call this feature makes.
  This is the SDK's own documented flag for excluding sessions the daemon itself already
  spawned — omitting it would leak the daemon's own Companion-owned sessions back into the
  discovery list as if they were external.
- `forkSession` must only ever be set `true` when `resumeSessionId` is present in the daemon's
  SDK-port layer — never unconditionally — so a normal fresh `start()` call (which passes
  neither) is provably unaffected by this feature.
- `SESSION_NOT_FOUND` must be added to `packages/web/src/relay-connection.ts`'s exhaustive
  `RPC_ERROR_MESSAGES: Record<RpcErrorCode, string>` map or the web package fails to
  typecheck (the map's type makes every `RpcErrorCode` a required key).
- Discovery (`list_discoverable_sessions`) is scoped to the daemon's known-projects list via
  `resolveKnownProjects`'s existing validation (`rpc-handlers.ts`) — never an arbitrary global
  filesystem scan across every project Claude Code has ever touched on the machine.
- Every task's verification gate is `npm run build && npm test && npm run typecheck` together,
  run from the repo root (`D:\Companion`) — not build+test alone. A prior project in this repo
  (`remote-session-start`) discovered that build+test alone can miss a broken test file that
  only `tsc --noEmit` catches (test files are excluded from `tsconfig.build.json`, and Vitest
  does not fully type-check transpiled tests).
- Shell/cwd hazard: if using a persistent shell, always prefix commands with
  `cd /d/Companion &&` explicitly. A prior project's shell got silently stranded in a
  subdirectory after an earlier `cd`, shrinking a later "full suite" run to one workspace
  without any error.

**Non-goals (do not implement, do not scope-creep into):**
- No live-attach to an in-flight external process — mechanically impossible with this SDK (no
  live-process handle, no observer mode, no lock/pid field).
- No liveness/"is the original terminal still open right now" detection — forking makes this
  unnecessary for safety.
- No dedup/bookkeeping across repeated adoptions of the same original session — re-adopting
  creates another independent fork, harmless, not tracked.
- No tool-call/tool-result detail in the historical summary — text-only (`role`/`text`),
  non-text content blocks dropped.
- No new relay surface, no new database migration, no relay code changes of any kind.

---

## Task 1: Protocol — `SESSION_NOT_FOUND` error code + `adopted_history` event + web error message

**Files:**
- Modify: `packages/protocol/src/rpc-errors.ts`
- Modify: `packages/protocol/src/rpc-errors.test.ts`
- Modify: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/events.test.ts`
- Modify: `packages/web/src/relay-connection.ts`

**Interfaces:**
- Produces: `RPC_ERROR_CODES.SESSION_NOT_FOUND` (value `'session_not_found'`); the
  `adopted_history` `SessionEvent` variant (`{type: 'adopted_history', sessionId: string,
  originalSessionId: string, messages: {role: 'user'|'assistant', text: string}[], truncated:
  boolean, at: number}`). Every later task in this plan consumes one or both of these.

- [ ] **Step 1: Write the failing protocol tests**

Add to `packages/protocol/src/rpc-errors.test.ts` (append inside the existing `describe`
block, after the `'includes the new session-start error codes'` test):

```typescript
  it('includes the session-adoption error code', () => {
    expect(RPC_ERROR_CODES.SESSION_NOT_FOUND).toBe('session_not_found');
  });
```

Add to `packages/protocol/src/events.test.ts` (append inside the existing `describe` block):

```typescript
  it('accepts a valid adopted_history event', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [
        { role: 'user', text: 'fix the bug in auth.ts' },
        { role: 'assistant', text: 'Found it — the token check was inverted.' },
      ],
      truncated: false,
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts an adopted_history event with an empty messages array', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [],
      truncated: false,
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an adopted_history event with an invalid message role', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [{ role: 'system', text: 'not a valid role here' }],
      truncated: false,
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an adopted_history event missing truncated', () => {
    const result = SessionEvent.safeParse({
      type: 'adopted_history',
      sessionId: 'new-session-1',
      originalSessionId: 'original-session-1',
      messages: [],
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/protocol packages/protocol/src/rpc-errors.test.ts packages/protocol/src/events.test.ts
```
Expected: FAIL — `RPC_ERROR_CODES.SESSION_NOT_FOUND` is `undefined`; `adopted_history` is
rejected as an unknown event type.

- [ ] **Step 3: Add the error code**

In `packages/protocol/src/rpc-errors.ts`, add inside the `RPC_ERROR_CODES` object (after
`CONCURRENT_SESSION_LIMIT`, before `NOT_CONNECTED`):

```typescript
  /** The `adopt_session` caller gave a `sessionId` that is no longer discoverable under the
   * given `projectPath` — never existed there, or existed but the underlying transcript file
   * has since been deleted or moved between the list call and the adopt call. One code covers
   * both causes, same reasoning as INVALID_PROJECT_PATH: the remedy is identical (re-list, pick
   * again). */
  SESSION_NOT_FOUND: 'session_not_found',
```

- [ ] **Step 4: Add the `adopted_history` event variant**

In `packages/protocol/src/events.ts`, add a new entry to the `SessionEvent` discriminated
union array (after the `events_dropped` entry, before the closing `]`):

```typescript
  z.object({
    // Emitted once by the daemon's SessionRunner.adopt() (see session-runner.ts), immediately
    // after session_started, when a session was created by forking an existing Claude Code
    // session that was started entirely outside Companion (see docs/superpowers/specs/
    // 2026-08-20-session-adoption-design.md). `at` here is the event's own emission timestamp,
    // matching every other SessionEvent variant's convention — it is not a per-message
    // timestamp; individual historical messages carry none (see the spec for why).
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

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/protocol packages/protocol/src/rpc-errors.test.ts packages/protocol/src/events.test.ts
```
Expected: PASS, all tests including the 6 new ones (1 in rpc-errors, 4 in events, plus the
pre-existing ones untouched).

- [ ] **Step 6: Add the web error message**

In `packages/web/src/relay-connection.ts`, add to the `RPC_ERROR_MESSAGES` object (after the
`CONCURRENT_SESSION_LIMIT` entry, before `NOT_CONNECTED`):

```typescript
  [RPC_ERROR_CODES.SESSION_NOT_FOUND]: "That session isn't available to adopt anymore. Try picking another.",
```

Note: `RPC_ERROR_MESSAGES` is typed `Record<RpcErrorCode, string>` — until this line is added,
`packages/protocol`'s widened `RpcErrorCode` type makes this object literal fail to typecheck
(missing required key). This is expected and is exactly why this step is part of Task 1, not
deferred.

- [ ] **Step 7: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; protocol gains 6 new passing tests (766 → 772 total across the
monorepo); typecheck clean across all 4 packages (protocol, relay, daemon, web) — this step is
what confirms Step 6 actually closed the exhaustiveness gap.

- [ ] **Step 8: Commit**

```bash
cd /d/Companion && git add packages/protocol/src/rpc-errors.ts packages/protocol/src/rpc-errors.test.ts packages/protocol/src/events.ts packages/protocol/src/events.test.ts packages/web/src/relay-connection.ts
git commit -m "protocol: add SESSION_NOT_FOUND error code and adopted_history event for session adoption"
```

---

## Task 2: Daemon — SDK port layer (`sessionId`/`resume`/`forkSession`, `listSessions`, `getSessionMessages`)

**Files:**
- Modify: `packages/daemon/src/agent-sdk-port.ts`
- Modify: `packages/daemon/src/real-agent-sdk.ts`
- Modify: `packages/daemon/src/real-agent-sdk.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this task has no dependency on the protocol package — it is
  purely an SDK-boundary translation layer).
- Produces: `AgentQueryOptions.sessionId?: string`, `AgentQueryOptions.resumeSessionId?:
  string`; two new exported port types and their real implementations:
  ```typescript
  export interface DiscoveredSession {
    sessionId: string;
    summary: string;
    firstPrompt: string | undefined;
    lastModified: number;
  }
  export type ListSessionsFn = (options: { dir: string }) => Promise<DiscoveredSession[]>;

  export interface HistoryMessage {
    role: 'user' | 'assistant';
    text: string;
  }
  export type GetSessionMessagesFn = (
    sessionId: string,
    options: { dir: string }
  ) => Promise<HistoryMessage[]>;
  ```
  `realListSessionsFn: ListSessionsFn` and `realGetSessionMessagesFn: GetSessionMessagesFn`,
  exported from `real-agent-sdk.ts`. Task 3 (`SessionRunner`) consumes
  `GetSessionMessagesFn`/`HistoryMessage`. Task 5 (`rpc-handlers.ts`) consumes `ListSessionsFn`/
  `DiscoveredSession`.

- [ ] **Step 1: Write the failing tests**

Read `packages/daemon/src/real-agent-sdk.test.ts` in full first to match its existing mocking
style for the `@anthropic-ai/claude-agent-sdk` module (it already mocks `query` — this task
mocks `listSessions`/`getSessionMessages` alongside it, in the same `vi.mock(...)` call).

Add to `packages/daemon/src/real-agent-sdk.test.ts`:

```typescript
describe('realQueryFn — resume and fork options', () => {
  it('passes sessionId, resume, and forkSession through when resumeSessionId is set', () => {
    let capturedOptions: Record<string, unknown> = {};
    vi.mocked(query).mockImplementation((args) => {
      capturedOptions = args.options as Record<string, unknown>;
      return (async function* () {})() as ReturnType<typeof query>;
    });

    realQueryFn({
      prompt: (async function* () {})(),
      options: {
        cwd: '/tmp/project',
        canUseTool: async () => ({ approved: true }),
        sessionId: 'new-session-1',
        resumeSessionId: 'original-session-1',
      },
    });

    expect(capturedOptions.sessionId).toBe('new-session-1');
    expect(capturedOptions.resume).toBe('original-session-1');
    expect(capturedOptions.forkSession).toBe(true);
  });

  it('passes neither sessionId, resume, nor forkSession when resumeSessionId is absent (normal fresh start)', () => {
    let capturedOptions: Record<string, unknown> = {};
    vi.mocked(query).mockImplementation((args) => {
      capturedOptions = args.options as Record<string, unknown>;
      return (async function* () {})() as ReturnType<typeof query>;
    });

    realQueryFn({
      prompt: (async function* () {})(),
      options: {
        cwd: '/tmp/project',
        canUseTool: async () => ({ approved: true }),
      },
    });

    expect(capturedOptions.sessionId).toBeUndefined();
    expect(capturedOptions.resume).toBeUndefined();
    expect(capturedOptions.forkSession).toBeUndefined();
  });
});

describe('realListSessionsFn', () => {
  it('maps SDK SDKSessionInfo entries into DiscoveredSession, passing includeProgrammatic: false', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        sessionId: 'abc-123',
        summary: 'Fix the auth bug',
        lastModified: 1700000000000,
        firstPrompt: 'fix the bug in auth.ts',
      },
    ] as Awaited<ReturnType<typeof listSessions>>);

    const result = await realListSessionsFn({ dir: '/tmp/project' });

    expect(listSessions).toHaveBeenCalledWith({ dir: '/tmp/project', includeProgrammatic: false });
    expect(result).toEqual([
      {
        sessionId: 'abc-123',
        summary: 'Fix the auth bug',
        firstPrompt: 'fix the bug in auth.ts',
        lastModified: 1700000000000,
      },
    ]);
  });

  it('maps a missing firstPrompt to undefined, not a crash', async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { sessionId: 'abc-123', summary: 'Untitled', lastModified: 1700000000000 },
    ] as Awaited<ReturnType<typeof listSessions>>);

    const result = await realListSessionsFn({ dir: '/tmp/project' });

    expect(result[0].firstPrompt).toBeUndefined();
  });
});

describe('realGetSessionMessagesFn', () => {
  it('extracts text from assistant and user messages, dropping system messages', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'user',
        uuid: 'u1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] },
      },
      {
        type: 'system',
        uuid: 'sys1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'system', content: [{ type: 'text', text: 'compact boundary' }] },
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    const result = await realGetSessionMessagesFn('s1', { dir: '/tmp/project' });

    expect(getSessionMessages).toHaveBeenCalledWith('s1', { dir: '/tmp/project' });
    expect(result).toEqual([
      { role: 'user', text: 'fix the bug' },
      { role: 'assistant', text: 'Found it.' },
    ]);
  });

  it('joins multiple text blocks within one message', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'First. ' }, { type: 'text', text: 'Second.' }] },
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    const result = await realGetSessionMessagesFn('s1', { dir: '/tmp/project' });

    expect(result).toEqual([{ role: 'assistant', text: 'First. Second.' }]);
  });

  it('drops a message that yields no text after extraction (e.g. a pure tool-use turn)', async () => {
    vi.mocked(getSessionMessages).mockResolvedValue([
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's1',
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    const result = await realGetSessionMessagesFn('s1', { dir: '/tmp/project' });

    expect(result).toEqual([]);
  });
});
```

Add `listSessions` and `getSessionMessages` to whatever `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` call already exists at the top of the file (alongside the existing mocked `query`), and import them (`import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';`) plus the two new functions under test
(`import { realQueryFn, realListSessionsFn, realGetSessionMessagesFn } from './real-agent-sdk.js';`).

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/real-agent-sdk.test.ts
```
Expected: FAIL — `realListSessionsFn`/`realGetSessionMessagesFn` don't exist; the resume/fork
test fails because `AgentQueryOptions` has no `sessionId`/`resumeSessionId` fields yet.

- [ ] **Step 3: Extend the port (`agent-sdk-port.ts`)**

Add to `packages/daemon/src/agent-sdk-port.ts` (the whole file's current content — `AgentMessage`,
`PermissionRequest`, `PermissionResponse`, `AgentQuery`, `AgentQueryOptions`, `QueryFn` — stays
exactly as-is; only additions below, appended to the end of the file):

```typescript
export interface AgentQueryOptions {
  cwd: string;
  canUseTool: (request: PermissionRequest) => Promise<PermissionResponse>;
  /** Set together with `resumeSessionId` when adopting an externally-started session — forces
   * the forked session's SDK-level session ID to match Companion's own generated session ID, so
   * the two ID spaces stay unified from the fork point forward. Never set on a normal fresh
   * start. */
  sessionId?: string;
  /** The original (externally-started) session ID to fork from. When set, the real adapter
   * passes `resume` + `forkSession: true` together to the SDK — never a plain, unforked
   * `resume` — so the original transcript file is never written to again, regardless of
   * whether another process still holds it open. Absent on a normal fresh start. */
  resumeSessionId?: string;
}

/** A session Claude Code knows about that this daemon did not spawn (e.g. a bare `claude` CLI
 * run, or an IDE session) — the unit `list_discoverable_sessions` returns to the phone. */
export interface DiscoveredSession {
  sessionId: string;
  summary: string;
  firstPrompt: string | undefined;
  lastModified: number;
}

export type ListSessionsFn = (options: { dir: string }) => Promise<DiscoveredSession[]>;

/** One turn of a session's prior (pre-adoption) conversation, reduced to plain text — no
 * timestamp (the SDK's transcript-read API doesn't expose one per message; see the session
 * adoption spec for why none is needed), no tool-call/tool-result detail. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type GetSessionMessagesFn = (
  sessionId: string,
  options: { dir: string }
) => Promise<HistoryMessage[]>;
```

Note: `AgentQueryOptions` already exists in the file with `cwd`/`canUseTool` — the block above
shows its *final* state (existing two fields plus the two new ones), not a duplicate
interface. Edit the existing interface in place; don't redeclare it.

- [ ] **Step 4: Implement in `real-agent-sdk.ts`**

Read the current file in full first (it's short — `realQueryFn` and `translateSdkMessage`).
Modify the `sdkQuery = query({...})` call inside `realQueryFn` to add two fields to its
`options` object (alongside the existing `cwd`/`canUseTool`):

```typescript
  const sdkQuery = query({
    prompt: toSdkPrompt(),
    options: {
      cwd: options.cwd,
      canUseTool: async (toolName, input, { requestId }) => {
        const response = await options.canUseTool({
          requestId,
          toolName,
          input,
        });
        return response.approved
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: response.reason ?? 'Denied' };
      },
      sessionId: options.sessionId,
      resume: options.resumeSessionId,
      forkSession: options.resumeSessionId ? true : undefined,
    },
  });
```

Then add, after the existing `translateSdkMessage` function (at the end of the file), the two
new exported functions plus one internal text-extraction helper:

```typescript
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { DiscoveredSession, HistoryMessage, ListSessionsFn, GetSessionMessagesFn } from './agent-sdk-port.js';

export const realListSessionsFn: ListSessionsFn = async ({ dir }) => {
  const sessions = await listSessions({ dir, includeProgrammatic: false });
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    summary: s.summary,
    firstPrompt: s.firstPrompt,
    lastModified: s.lastModified,
  }));
};

/**
 * `getSessionMessages` returns `message: unknown` per entry (the SDK's own transcript-read type
 * is deliberately loose) — extracted the same defensive way `translateSdkMessage` above handles
 * the live `SDKMessage` union: treat it as `{content?: unknown}`, keep only `text`-type content
 * blocks, join their text. A message that yields no text after extraction (a pure tool-use or
 * tool-result turn) is dropped rather than emitted as an empty string.
 */
function extractText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
    )
    .map((block) => block.text)
    .join('');
}

export const realGetSessionMessagesFn: GetSessionMessagesFn = async (sessionId, { dir }) => {
  const entries = await getSessionMessages(sessionId, { dir });
  const messages: HistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const text = extractText(entry.message);
    if (text === '') continue;
    messages.push({ role: entry.type, text });
  }
  return messages;
};
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/real-agent-sdk.test.ts
```
Expected: PASS, all tests including the 6 new ones, and every pre-existing test in this file
still passing unchanged.

- [ ] **Step 6: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; daemon gains 6 new passing tests; typecheck clean across all 4 packages.

- [ ] **Step 7: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/agent-sdk-port.ts packages/daemon/src/real-agent-sdk.ts packages/daemon/src/real-agent-sdk.test.ts
git commit -m "daemon: extend the SDK port with resume/fork and session-discovery primitives"
```

---

## Task 3: Daemon — `SessionRunner.adopt()`

**Files:**
- Modify: `packages/daemon/src/session-runner.ts`
- Modify: `packages/daemon/src/session-runner.test.ts`

**Interfaces:**
- Consumes: `AgentQueryOptions.sessionId`/`resumeSessionId`, `GetSessionMessagesFn`,
  `HistoryMessage` (Task 2); `adopted_history` `SessionEvent` (Task 1).
- Produces: `SessionRunner.adopt(originalSessionId: string): void`; `SessionRunnerOptions`
  gains a new required field `getSessionMessagesFn: GetSessionMessagesFn`. Task 4
  (`SessionManager.adoptSession`) consumes `adopt()`; Task 4 also must thread
  `getSessionMessagesFn` through `SessionManagerOptions` into every `SessionRunner`
  construction (fresh-start sessions included — they simply never call it, mirroring how
  `projectStoreFilePath` became a required, always-threaded `SessionManagerOptions` field in
  the prior remote-session-start project even though not every operation reads it).

- [ ] **Step 1: Write the failing tests**

Read `packages/daemon/src/session-runner.ts` and `session-runner.test.ts` in full first — the
`createMockAgent()` helper and the existing `SessionRunnerOptions` construction pattern are
what these new tests and the implementation below extend, not replace.

Add to `packages/daemon/src/session-runner.test.ts`:

```typescript
function createMockGetSessionMessagesFn(messages: { role: 'user' | 'assistant'; text: string }[]) {
  return vi.fn(async () => messages);
}

describe('SessionRunner.adopt', () => {
  it('emits session_started with no prompt pushed to the input queue', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const getSessionMessagesFn = createMockGetSessionMessagesFn([]);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(events[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'session-new-1',
      projectPath: '/tmp/project',
    });
    // If adopt() had pushed an initial prompt the way start() does, it would be the first item
    // this iterator yields. Push a sentinel now via the runner's own public injectPrompt() and
    // confirm the sentinel — not some earlier prompt — is what comes out first, proving the
    // queue was genuinely empty when adopt() ran (not just asserting on a runtime race).
    runner.injectPrompt('sentinel');
    const iterator = agent.getPrompt()[Symbol.asyncIterator]();
    const { value } = await iterator.next();
    expect(value).toEqual({ type: 'user', text: 'sentinel' });
  });

  it('passes sessionId and resumeSessionId through to queryFn', async () => {
    const agent = createMockAgent();
    const getSessionMessagesFn = createMockGetSessionMessagesFn([]);
    let capturedOptions: { sessionId?: string; resumeSessionId?: string } = {};
    const capturingQueryFn: QueryFn = (args) => {
      capturedOptions = args.options;
      return agent.queryFn(args);
    };
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: capturingQueryFn,
      getSessionMessagesFn,
      onEvent: () => {},
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedOptions.sessionId).toBe('session-new-1');
    expect(capturedOptions.resumeSessionId).toBe('original-session-1');
  });

  it('fetches history and emits one adopted_history event after session_started', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const getSessionMessagesFn = createMockGetSessionMessagesFn([
      { role: 'user', text: 'fix the bug in auth.ts' },
      { role: 'assistant', text: 'Found it — the token check was inverted.' },
    ]);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(getSessionMessagesFn).toHaveBeenCalledWith('original-session-1', { dir: '/tmp/project' });
    expect(events[1]).toMatchObject({
      type: 'adopted_history',
      sessionId: 'session-new-1',
      originalSessionId: 'original-session-1',
      messages: [
        { role: 'user', text: 'fix the bug in auth.ts' },
        { role: 'assistant', text: 'Found it — the token check was inverted.' },
      ],
      truncated: false,
    });
  });

  it('caps history to the most recent 50 messages and sets truncated: true', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const allMessages = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as const,
      text: `message ${i}`,
    }));
    const getSessionMessagesFn = createMockGetSessionMessagesFn(allMessages);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    const historyEvent = events.find((e) => e.type === 'adopted_history');
    expect(historyEvent).toMatchObject({ truncated: true });
    expect((historyEvent as { messages: unknown[] }).messages).toHaveLength(50);
    expect((historyEvent as { messages: { text: string }[] }).messages[0].text).toBe('message 10');
    expect((historyEvent as { messages: { text: string }[] }).messages[49].text).toBe('message 59');
  });

  it('still processes assistant_text and other live events normally after adopting', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const getSessionMessagesFn = createMockGetSessionMessagesFn([]);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));
    agent.outgoing.push({ type: 'assistant_text', text: 'How can I help?' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.some((e) => e.type === 'assistant_text' && e.text === 'How can I help?')).toBe(true);
  });
});
```

Every pre-existing test in this file constructs `SessionRunner` without `getSessionMessagesFn`
— since it's a new **required** field, every one of those constructions will fail to typecheck
once Step 3 lands. Fix each by adding `getSessionMessagesFn: vi.fn(async () => [])` (a
trivial no-op stub — none of the existing `start()`-based tests ever call it, so its return
value doesn't matter, only its presence does) to every existing `new SessionRunner({...})`
call in this file. Do this as part of Step 3 below, not as a separate step — the two changes
land together in the same commit since neither typechecks without the other.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/session-runner.test.ts
```
Expected: FAIL — `runner.adopt` is not a function; `SessionRunnerOptions` has no
`getSessionMessagesFn` field yet (this second failure will show as a TypeScript error via
Vitest's esbuild transform, not a runtime assertion failure).

- [ ] **Step 3: Implement `adopt()` and thread `getSessionMessagesFn`**

In `packages/daemon/src/session-runner.ts`, add the import and extend
`SessionRunnerOptions`:

```typescript
import type { GetSessionMessagesFn } from './agent-sdk-port.js';

export interface SessionRunnerOptions {
  id: string;
  projectPath: string;
  queryFn: QueryFn;
  getSessionMessagesFn: GetSessionMessagesFn;
  onEvent: (event: SessionEvent) => void;
}
```

Add a private field and constructor assignment (alongside the existing ones):

```typescript
  private readonly getSessionMessagesFn: GetSessionMessagesFn;

  constructor(options: SessionRunnerOptions) {
    this.id = options.id;
    this.projectPath = options.projectPath;
    this.queryFn = options.queryFn;
    this.getSessionMessagesFn = options.getSessionMessagesFn;
    this.onEvent = options.onEvent;
  }
```

Add the exact cap constant near the top of the file (alongside the class, module-level):

```typescript
/** Most recent N prior messages carried into an adopted session's `adopted_history` event.
 * Bounded for the same reason every other cap in this codebase is bounded — see
 * docs/superpowers/specs/2026-08-20-session-adoption-design.md. */
const HISTORY_MESSAGE_CAP = 50;
```

Add the `adopt` method, immediately after the existing `start(initialPrompt)` method:

```typescript
  /**
   * Starts a session by forking an existing, externally-started Claude Code session rather than
   * beginning a brand-new one. Structurally mirrors `start()` — same query construction, same
   * session_started emission, same drainMessages() loop — with two differences: no initial
   * prompt is pushed (the user lands in the session free to type whenever), and the original
   * session's prior conversation is fetched once and emitted as a single adopted_history event
   * right after session_started.
   */
  adopt(originalSessionId: string): void {
    this.agentQuery = this.queryFn({
      prompt: this.inputQueue,
      options: {
        cwd: this.projectPath,
        canUseTool: (request) => this.handlePermissionRequest(request),
        sessionId: this.id,
        resumeSessionId: originalSessionId,
      },
    });
    this.emit({
      type: 'session_started',
      sessionId: this.id,
      projectPath: this.projectPath,
      at: Date.now(),
    });
    void this.emitAdoptedHistory(originalSessionId);
    void this.drainMessages();
  }

  private async emitAdoptedHistory(originalSessionId: string): Promise<void> {
    const allMessages = await this.getSessionMessagesFn(originalSessionId, { dir: this.projectPath });
    const truncated = allMessages.length > HISTORY_MESSAGE_CAP;
    const messages = allMessages.slice(-HISTORY_MESSAGE_CAP);
    this.emit({
      type: 'adopted_history',
      sessionId: this.id,
      originalSessionId,
      messages,
      truncated,
      at: Date.now(),
    });
  }
```

Note `void this.emitAdoptedHistory(...)` — fire-and-forget, same reasoning as
`session-manager.ts`'s existing `void recordProjectUsed(...)` call: history delivery must never
block or fail the session actually starting. A rejected `getSessionMessagesFn` call here is
currently unhandled (no `.catch`) — add one:

```typescript
    void this.emitAdoptedHistory(originalSessionId).catch(() => {
      // History delivery is best-effort: a failed fetch (e.g. the original transcript file was
      // deleted between adopt_session's re-validation and this call) must not crash or block
      // the now-live adopted session. The session proceeds with no prior-conversation context
      // shown, which is a strictly worse UX than showing it, never a broken one.
    });
```
(Replace the plain `void this.emitAdoptedHistory(originalSessionId);` line above with this
`.catch(...)`-guarded version.)

Now fix every pre-existing `new SessionRunner({...})` construction in
`session-runner.test.ts` (both in `createMockAgent`-based tests throughout the file and any
other construction site) by adding `getSessionMessagesFn: vi.fn(async () => [])` to each
options object.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/session-runner.test.ts
```
Expected: PASS — all 5 new `adopt` tests, and every pre-existing test in this file (now with
`getSessionMessagesFn` added to their constructions) still passing.

- [ ] **Step 5: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; daemon gains 5 new passing tests; typecheck clean across all 4 packages
— this step catches any OTHER file in the daemon package that constructs `SessionRunner`
directly and would otherwise silently fail only under `tsc --noEmit` (search
`grep -rn "new SessionRunner(" packages/daemon/src` yourself before declaring this task done,
independent of what this step's typecheck run reports, since a prior task in a previous project
in this exact repo found a test file missed by a similar grep during planning — verify by
running the grep, not by trusting this plan's own list of files).

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/session-runner.ts packages/daemon/src/session-runner.test.ts
git commit -m "daemon: add SessionRunner.adopt() to fork and continue an externally-started session"
```

---

## Task 4: Daemon — `SessionManager.adoptSession()`

**Files:**
- Modify: `packages/daemon/src/session-manager.ts`
- Modify: `packages/daemon/src/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionRunner.adopt()`, `SessionRunnerOptions.getSessionMessagesFn` (Task 3).
- Produces: `SessionManager.adoptSession(projectPath: string, originalSessionId: string):
  SessionRunner`; `SessionManagerOptions` gains a new required field `getSessionMessagesFn:
  GetSessionMessagesFn`. Task 5 (`rpc-handlers.ts`) consumes `adoptSession`.

- [ ] **Step 1: Write the failing tests**

Read `packages/daemon/src/session-manager.ts` and `session-manager.test.ts` in full first —
`startSession`'s cap-check/`isCapExceeded`-marker/`sessions.set`/stopped-cleanup wiring and the
test file's `makeManager` helper are what this task's `adoptSession` and its tests mirror.

Add to `packages/daemon/src/session-manager.test.ts` (adjust `makeManager`'s signature and
every direct `new SessionManager({...})` construction in this file to include
`getSessionMessagesFn: vi.fn(async () => [])` — same reasoning as Task 3's fix to
`session-runner.test.ts`, since this is now also a required option here):

```typescript
describe('SessionManager.adoptSession', () => {
  it('creates a runner via SessionRunner.adopt, not start', async () => {
    const { manager } = await makeManager();
    const runner = manager.adoptSession('/tmp/project', 'original-session-1');

    expect(runner.id).toBeTruthy();
    expect(runner.status).toBe('running');
  });

  it('counts toward the concurrency cap exactly like startSession', async () => {
    const { manager } = await makeManager({ maxConcurrentSessions: 1 });
    manager.adoptSession('/tmp/project-a', 'original-session-1');

    expect(() => manager.startSession('/tmp/project-b', 'do something')).toThrow(
      /already at the limit/
    );
  });

  it('records the project as used, same as startSession', async () => {
    const { manager, projectStoreFilePath } = await makeManager();
    manager.adoptSession('/tmp/project', 'original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    const known = await listKnownProjects({ filePath: projectStoreFilePath });
    expect(known.some((p) => p.path === '/tmp/project')).toBe(true);
  });

  it('removes the runner from the sessions map once it stops, same as a started session', async () => {
    const { manager } = await makeManager();
    const runner = manager.adoptSession('/tmp/project', 'original-session-1');
    await runner.stop();

    expect(() => manager.getSession(runner.id)).toThrow();
  });
});
```

(These tests assume `makeManager()` returns `{ manager, projectStoreFilePath }` — check the
actual current return shape in the file first and adjust the destructuring above to match
exactly; don't guess if it differs.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/session-manager.test.ts
```
Expected: FAIL — `manager.adoptSession` is not a function; every existing `SessionManager`
construction fails to typecheck without `getSessionMessagesFn`.

- [ ] **Step 3: Implement**

In `packages/daemon/src/session-manager.ts`, add the import and extend
`SessionManagerOptions`:

```typescript
import type { GetSessionMessagesFn } from './agent-sdk-port.js';

export interface SessionManagerOptions {
  queryFn: QueryFn;
  getSessionMessagesFn: GetSessionMessagesFn;
  onEvent: (event: SessionEvent) => void;
  projectStoreFilePath: string;
  maxConcurrentSessions?: number;
}
```

Add a private field and constructor assignment (alongside the existing ones):

```typescript
  private readonly getSessionMessagesFn: GetSessionMessagesFn;

  constructor(options: SessionManagerOptions) {
    this.queryFn = options.queryFn;
    this.getSessionMessagesFn = options.getSessionMessagesFn;
    this.onEvent = options.onEvent;
    this.projectStoreFilePath = options.projectStoreFilePath;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  }
```

**Before adding `adoptSession`, fix the existing `startSession` method first** — it builds a
`SessionRunner` too, and `SessionRunnerOptions.getSessionMessagesFn` became a *required* field
in Task 3. Without this edit, `startSession`'s existing construction stops typechecking the
moment this task's `SessionManagerOptions` change lands, breaking the build for a method this
task never otherwise touches. In the existing `startSession` method, find:

```typescript
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      onEvent: (event) => {
```

and add `getSessionMessagesFn: this.getSessionMessagesFn,` immediately after `queryFn:
this.queryFn,` (as its own line, same indentation) — the rest of that construction (the
`onEvent` wrapper with its stopped-session cleanup, everything below it) stays exactly as it is
today.

Now add `adoptSession`, immediately after the (now-fixed) existing `startSession` method —
structurally identical to it (same cap check, same `id`/`runner`/`sessions.set`/stopped-cleanup
wiring, same fire-and-forget `recordProjectUsed`), with the one substantive difference being the
final call into the runner:

```typescript
  adoptSession(projectPath: string, originalSessionId: string): SessionRunner {
    if (this.activeCount() >= this.maxConcurrentSessions) {
      throw Object.assign(
        new Error(
          `Cannot adopt a session: already at the limit of ${this.maxConcurrentSessions} concurrent sessions.`
        ),
        { isCapExceeded: true }
      );
    }
    const id = randomUUID();
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      getSessionMessagesFn: this.getSessionMessagesFn,
      onEvent: (event) => {
        if (event.type === 'stopped') {
          this.sessions.delete(id);
        }
        this.onEvent(event);
      },
    });
    this.sessions.set(id, runner);
    try {
      runner.adopt(originalSessionId);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    void recordProjectUsed(projectPath, { filePath: this.projectStoreFilePath }).catch(() => {});
    return runner;
  }
```

Now fix every pre-existing `SessionManager` construction in `session-manager.test.ts`
(including inside `makeManager` and any inline ones) by adding
`getSessionMessagesFn: vi.fn(async () => [])`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/session-manager.test.ts
```
Expected: PASS — all 4 new `adoptSession` tests, plus every pre-existing test in this file.

- [ ] **Step 5: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; daemon gains 4 new passing tests; typecheck clean across all 4 packages
— run `grep -rn "new SessionManager(" packages/daemon/src` yourself and fix any construction
site this task's own file list didn't anticipate (same discipline as Task 3's Step 5 — a prior
project in this repo found exactly this kind of gap in its own pre-flight scan).

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/session-manager.ts packages/daemon/src/session-manager.test.ts
git commit -m "daemon: add SessionManager.adoptSession(), reusing the concurrency cap and project-history wiring"
```

---

## Task 5: Daemon — `list_discoverable_sessions`/`adopt_session` RPC methods + `main.ts` wiring

**Files:**
- Modify: `packages/daemon/src/rpc-handlers.ts`
- Modify: `packages/daemon/src/rpc-handlers.test.ts`
- Modify: `packages/daemon/src/main.ts`

**Interfaces:**
- Consumes: `RPC_ERROR_CODES.SESSION_NOT_FOUND` (Task 1); `ListSessionsFn`,
  `DiscoveredSession`, `realListSessionsFn`, `realGetSessionMessagesFn` (Task 2);
  `SessionManager.adoptSession`, `SessionManagerOptions.getSessionMessagesFn` (Task 4).
- Produces: `list_discoverable_sessions` and `adopt_session` entries in `rpc-handlers.ts`'s
  `REGISTRY`. Task 6 (`StartSessionSheet.tsx`) consumes both via `callDaemon`.

- [ ] **Step 1: Write the failing tests**

Read `packages/daemon/src/rpc-handlers.ts` and `rpc-handlers.test.ts` in full first —
`resolveKnownProjects`, `isStartSessionParams`, the `REGISTRY` object, and `dispatchRpc`'s
`rpcCode`-marker convention are the established patterns this task's two new handlers mirror
exactly, not reinvent. Note the file's `baseDeps: RpcHandlerDeps` test fixture (mentioned in
the file's own comment as satisfying required fields with placeholder values) — it needs a new
`listSessionsFn` field added once Step 3 makes it required.

Add to `packages/daemon/src/rpc-handlers.test.ts`:

```typescript
describe('list_discoverable_sessions', () => {
  it('returns SESSION_NOT_FOUND — actually INVALID_PROJECT_PATH — for an unknown project path', async () => {
    const outcome = await dispatchRpc(
      'list_discoverable_sessions',
      { projectPath: '/not/a/known/project' },
      { ...baseDeps, listSessionsFn: vi.fn(async () => []) }
    );
    expect(outcome.error).toBe(RPC_ERROR_CODES.INVALID_PROJECT_PATH);
  });

  it('calls listSessionsFn with includeProgrammatic scoping handled by the fn itself, and returns its result', async () => {
    const filePath = join(tempDir, 'daemon-projects.json');
    await recordProjectUsed('/tmp/project', { filePath });
    const listSessionsFn = vi.fn(async () => [
      { sessionId: 'abc', summary: 'Fix bug', firstPrompt: 'fix it', lastModified: 1700000000000 },
    ]);

    const outcome = await dispatchRpc(
      'list_discoverable_sessions',
      { projectPath: '/tmp/project' },
      { ...baseDeps, projectStoreFilePath: filePath, listSessionsFn }
    );

    expect(listSessionsFn).toHaveBeenCalledWith({ dir: '/tmp/project' });
    expect(outcome.result).toEqual([
      { sessionId: 'abc', summary: 'Fix bug', firstPrompt: 'fix it', lastModified: 1700000000000 },
    ]);
  });
});

describe('adopt_session', () => {
  it('returns INVALID_PROJECT_PATH for an unknown project path', async () => {
    const outcome = await dispatchRpc(
      'adopt_session',
      { projectPath: '/not/a/known/project', sessionId: 'abc' },
      { ...baseDeps, listSessionsFn: vi.fn(async () => []) }
    );
    expect(outcome.error).toBe(RPC_ERROR_CODES.INVALID_PROJECT_PATH);
  });

  it('returns SESSION_NOT_FOUND when sessionId is not in a fresh discoverable-sessions call', async () => {
    const filePath = join(tempDir, 'daemon-projects.json');
    await recordProjectUsed('/tmp/project', { filePath });
    const listSessionsFn = vi.fn(async () => []);

    const outcome = await dispatchRpc(
      'adopt_session',
      { projectPath: '/tmp/project', sessionId: 'nonexistent' },
      { ...baseDeps, projectStoreFilePath: filePath, listSessionsFn }
    );

    expect(outcome.error).toBe(RPC_ERROR_CODES.SESSION_NOT_FOUND);
  });

  it('adopts a valid, currently-discoverable session and returns its id/status', async () => {
    const filePath = join(tempDir, 'daemon-projects.json');
    await recordProjectUsed('/tmp/project', { filePath });
    const listSessionsFn = vi.fn(async () => [
      { sessionId: 'abc', summary: 'Fix bug', firstPrompt: 'fix it', lastModified: 1700000000000 },
    ]);
    const manager = new SessionManager({
      queryFn: createMockQueryFn(),
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: () => {},
      projectStoreFilePath: filePath,
    });

    const outcome = await dispatchRpc(
      'adopt_session',
      { projectPath: '/tmp/project', sessionId: 'abc' },
      { ...baseDeps, manager, projectStoreFilePath: filePath, listSessionsFn }
    );

    expect(outcome.result).toMatchObject({ status: 'running' });
    expect((outcome.result as { id: string }).id).toBeTruthy();
  });

  it('maps a cap-exceeded adoptSession failure to CONCURRENT_SESSION_LIMIT', async () => {
    const filePath = join(tempDir, 'daemon-projects.json');
    await recordProjectUsed('/tmp/project', { filePath });
    const listSessionsFn = vi.fn(async () => [
      { sessionId: 'abc', summary: 'Fix bug', firstPrompt: 'fix it', lastModified: 1700000000000 },
    ]);
    const manager = new SessionManager({
      queryFn: createMockQueryFn(),
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: () => {},
      projectStoreFilePath: filePath,
      maxConcurrentSessions: 0,
    });

    const outcome = await dispatchRpc(
      'adopt_session',
      { projectPath: '/tmp/project', sessionId: 'abc' },
      { ...baseDeps, manager, projectStoreFilePath: filePath, listSessionsFn }
    );

    expect(outcome.error).toBe(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT);
  });

  it('returns HANDLER_ERROR (not SESSION_NOT_FOUND or CONCURRENT_SESSION_LIMIT) for a genuine adopt crash', async () => {
    const filePath = join(tempDir, 'daemon-projects.json');
    await recordProjectUsed('/tmp/project', { filePath });
    const listSessionsFn = vi.fn(async () => [
      { sessionId: 'abc', summary: 'Fix bug', firstPrompt: 'fix it', lastModified: 1700000000000 },
    ]);
    const manager = new SessionManager({
      queryFn: createThrowingQueryFn(),
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: () => {},
      projectStoreFilePath: filePath,
    });

    const outcome = await dispatchRpc(
      'adopt_session',
      { projectPath: '/tmp/project', sessionId: 'abc' },
      { ...baseDeps, manager, projectStoreFilePath: filePath, listSessionsFn }
    );

    expect(outcome.error).toBe(RPC_ERROR_CODES.HANDLER_ERROR);
  });
});
```

(`createThrowingQueryFn` is referenced elsewhere in this file already per the earlier grep of
its contents — reuse it, don't redefine it. `tempDir` is likewise an existing fixture in this
file's `beforeEach`/`afterEach` — use the file's real setup, not a new one.)

Add `listSessionsFn: vi.fn(async () => [])` to the file's `baseDeps: RpcHandlerDeps` fixture.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/rpc-handlers.test.ts
```
Expected: FAIL — `list_discoverable_sessions`/`adopt_session` are unregistered methods
(`dispatchRpc` returns `UNKNOWN_METHOD` for both); `baseDeps` fails to typecheck without
`listSessionsFn` once Step 3 makes it required.

- [ ] **Step 3: Implement**

In `packages/daemon/src/rpc-handlers.ts`, add to the imports:

```typescript
import type { ListSessionsFn, DiscoveredSession } from './agent-sdk-port.js';
```

Extend `RpcHandlerDeps`:

```typescript
export interface RpcHandlerDeps {
  version: string;
  startedAt: number;
  now?: () => number;
  manager: SessionManager;
  projectStoreFilePath: string;
  projectsRoot: string | undefined;
  /** Needed by list_discoverable_sessions and adopt_session to enumerate sessions Claude Code
   * knows about for a project that this daemon did not itself spawn. */
  listSessionsFn: ListSessionsFn;
}
```

Add a params-validation helper (alongside the existing `isStartSessionParams`):

```typescript
interface AdoptSessionParams {
  projectPath: string;
  sessionId: string;
}

function isAdoptSessionParams(params: unknown): params is AdoptSessionParams {
  return (
    typeof params === 'object' &&
    params !== null &&
    typeof (params as AdoptSessionParams).projectPath === 'string' &&
    typeof (params as AdoptSessionParams).sessionId === 'string'
  );
}
```

Add the two new entries to the `REGISTRY` object (after the existing `start_session` entry):

```typescript
  list_discoverable_sessions: async (params, deps): Promise<DiscoveredSession[]> => {
    if (
      typeof params !== 'object' ||
      params === null ||
      typeof (params as { projectPath?: unknown }).projectPath !== 'string'
    ) {
      throw Object.assign(new Error('invalid list_discoverable_sessions params'), {
        rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH,
      });
    }
    const { projectPath } = params as { projectPath: string };
    const known = await resolveKnownProjects(deps);
    if (!known.some((p) => p.path === projectPath)) {
      throw Object.assign(new Error('invalid project path'), { rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH });
    }
    return deps.listSessionsFn({ dir: projectPath });
  },
  adopt_session: async (params, deps): Promise<{ id: string; status: string }> => {
    if (!isAdoptSessionParams(params)) {
      throw Object.assign(new Error('invalid adopt_session params'), {
        rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH,
      });
    }
    const known = await resolveKnownProjects(deps);
    if (!known.some((p) => p.path === params.projectPath)) {
      throw Object.assign(new Error('invalid project path'), { rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH });
    }
    const discoverable = await deps.listSessionsFn({ dir: params.projectPath });
    if (!discoverable.some((s) => s.sessionId === params.sessionId)) {
      throw Object.assign(new Error('session not found'), { rpcCode: RPC_ERROR_CODES.SESSION_NOT_FOUND });
    }
    try {
      const runner = deps.manager.adoptSession(params.projectPath, params.sessionId);
      return { id: runner.id, status: runner.status };
    } catch (err) {
      if (err instanceof Error && (err as Error & { isCapExceeded?: boolean }).isCapExceeded) {
        throw Object.assign(new Error(err.message), { rpcCode: RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT });
      }
      throw err;
    }
  },
```

Now update `packages/daemon/src/main.ts`: import the two real functions and thread them
through both construction sites.

```typescript
import { realQueryFn, realListSessionsFn, realGetSessionMessagesFn } from './real-agent-sdk.js';
```

In the `SessionManager` construction (around line 187):

```typescript
  const manager = new SessionManager({
    queryFn: realQueryFn,
    getSessionMessagesFn: realGetSessionMessagesFn,
    onEvent: (event) => {
      eventLog.push(event);
      console.log(`[${event.sessionId}] ${event.type}`);
      relayClient?.sendEvent(event.sessionId, event);
    },
    projectStoreFilePath: PROJECTS_FILE_PATH,
    maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
  });
```

In the `onRpcRequest` handler's `dispatchRpc` call (around line 254):

```typescript
          onRpcRequest: (method, params) =>
            dispatchRpc(method, params, {
              version: DAEMON_VERSION,
              startedAt: DAEMON_STARTED_AT,
              manager,
              projectStoreFilePath: PROJECTS_FILE_PATH,
              projectsRoot: PROJECTS_ROOT,
              listSessionsFn: realListSessionsFn,
            }),
```

Also fix every pre-existing `new SessionManager({...})` construction elsewhere in
`rpc-handlers.test.ts` (the ones inside individual test bodies, not just `baseDeps`) by adding
`getSessionMessagesFn: vi.fn(async () => [])`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/rpc-handlers.test.ts
```
Expected: PASS — all 7 new tests, plus every pre-existing test in this file.

- [ ] **Step 5: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; daemon gains 7 new passing tests; typecheck clean across all 4 packages
— this is the step that catches whether `main.ts`'s two wiring edits actually satisfy the now
wider `RpcHandlerDeps`/`SessionManagerOptions` types.

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/rpc-handlers.ts packages/daemon/src/rpc-handlers.test.ts packages/daemon/src/main.ts
git commit -m "daemon: add list_discoverable_sessions and adopt_session RPC methods"
```

---

## Task 6: Web — discovered-session picker in `StartSessionSheet`

**Files:**
- Modify: `packages/web/src/StartSessionSheet.tsx`
- Modify: `packages/web/src/StartSessionSheet.test.tsx`

**Interfaces:**
- Consumes: `list_discoverable_sessions`/`adopt_session` (Task 5, called via `callDaemon`,
  matching this file's existing `list_projects`/`start_session` usage exactly); `RpcError`
  (already imported in this file); `formatRelativeTime` from
  `packages/web/src/format-relative-time.ts` (existing, reused — do not reimplement relative
  time formatting).
- Produces: no new exports — this task only changes `StartSessionSheet`'s internal phase
  machine and rendering. Nothing downstream in this plan consumes anything new from this file.

- [ ] **Step 1: Write the failing tests**

Read `packages/web/src/StartSessionSheet.tsx` and `StartSessionSheet.test.tsx` in full first —
the current `Phase` union (`loading-projects | load-error | picking | prompting`), the
`mockCallDaemon` helper, and the existing 3 tests (project list loads, prompt-and-submit,
error-preserves-typed-input) are what this task's new `choosing-session` phase and tests
extend, not replace.

Add to `packages/web/src/StartSessionSheet.test.tsx`:

```typescript
const twoDiscoveredSessions = [
  { sessionId: 'abc', summary: 'Fix the auth bug', firstPrompt: 'fix the bug in auth.ts', lastModified: Date.now() - 60_000 },
  { sessionId: 'def', summary: 'Refactor the API layer', firstPrompt: undefined, lastModified: Date.now() - 3_600_000 },
];

describe('StartSessionSheet — session discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips straight to the prompt step when no sessions are discoverable', async () => {
    mockCallDaemon(async (method) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'list_discoverable_sessions') return [];
      throw new Error('unexpected method');
    });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));

    expect(await screen.findByRole('textbox', { name: /what should claude do/i })).toBeInTheDocument();
  });

  it('shows discovered sessions alongside a "start new" option when any are found', async () => {
    mockCallDaemon(async (method) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'list_discoverable_sessions') return twoDiscoveredSessions;
      throw new Error('unexpected method');
    });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));

    expect(await screen.findByRole('button', { name: /fix the auth bug/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refactor the api layer/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start a new session instead/i })).toBeInTheDocument();
  });

  it('"start a new session instead" leads to the normal prompt step', async () => {
    mockCallDaemon(async (method) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'list_discoverable_sessions') return twoDiscoveredSessions;
      throw new Error('unexpected method');
    });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));
    await userEvent.click(await screen.findByRole('button', { name: /start a new session instead/i }));

    expect(await screen.findByRole('textbox', { name: /what should claude do/i })).toBeInTheDocument();
  });

  it('tapping a discovered session calls adopt_session and reports onStarted with the new id', async () => {
    const onStarted = vi.fn();
    mockCallDaemon(async (method, params) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'list_discoverable_sessions') return twoDiscoveredSessions;
      if (method === 'adopt_session') {
        expect(params).toEqual({ projectPath: '/home/me/companion', sessionId: 'abc' });
        return { id: 'forked-session-1', status: 'running' };
      }
      throw new Error('unexpected method');
    });
    renderSheet(onStarted);

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));
    await userEvent.click(await screen.findByRole('button', { name: /fix the auth bug/i }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('forked-session-1'));
  });

  it('a list_discoverable_sessions failure fails silently toward the normal prompt step', async () => {
    mockCallDaemon(async (method) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'list_discoverable_sessions') throw new Error('boom');
      throw new Error('unexpected method');
    });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));

    expect(await screen.findByRole('textbox', { name: /what should claude do/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/StartSessionSheet.test.tsx
```
Expected: FAIL — no `choosing-session` phase exists yet; `list_discoverable_sessions` is never
called; every new test's queries find nothing.

- [ ] **Step 3: Implement**

In `packages/web/src/StartSessionSheet.tsx`, add the import:

```typescript
import { formatRelativeTime } from './format-relative-time';
```

Add a local type for the discovered-session shape (mirroring how `ProjectListEntry` is defined
locally in `ProjectPicker.tsx` rather than imported across the daemon/web process boundary —
same established convention this codebase already uses for every RPC-shaped type):

```typescript
interface DiscoveredSession {
  sessionId: string;
  summary: string;
  firstPrompt: string | undefined;
  lastModified: number;
}
```

Extend the `Phase` union (replacing the current one):

```typescript
type Phase =
  | { step: 'loading-projects' }
  | { step: 'load-error'; message: string }
  | { step: 'picking'; projects: ProjectListEntry[] }
  | { step: 'checking-sessions'; project: ProjectListEntry }
  | { step: 'choosing-session'; project: ProjectListEntry; sessions: DiscoveredSession[] }
  | { step: 'prompting'; project: ProjectListEntry };
```

Replace the `ProjectPicker`'s `onSelect` handler (currently
`onSelect={(project) => setPhase({ step: 'prompting', project })}`) with a new function that
kicks off discovery instead of jumping straight to prompting:

```typescript
  function handleSelectProject(project: ProjectListEntry) {
    setPhase({ step: 'checking-sessions', project });
    callDaemon('list_discoverable_sessions', { projectPath: project.path })
      .then((result) => {
        const sessions = result as DiscoveredSession[];
        if (sessions.length === 0) {
          setPhase({ step: 'prompting', project });
        } else {
          setPhase({ step: 'choosing-session', project, sessions });
        }
      })
      .catch(() => {
        // Discovery is a convenience, never a blocking requirement — unlike list_projects
        // above, whose failure surfaces as load-error, a failed discovery call fails silently
        // toward the normal fresh-start prompt so the user is never blocked from starting a
        // session just because discovery couldn't run.
        setPhase({ step: 'prompting', project });
      });
  }
```

Update the `ProjectPicker` usage to call this new handler:

```typescript
        {phase.step === 'picking' && (
          <ProjectPicker projects={phase.projects} onSelect={handleSelectProject} />
        )}
```

Add rendering for the two new phases (after the `'picking'` block, before the `'prompting'`
block):

```typescript
        {phase.step === 'checking-sessions' && <p className="text-ink-muted">Checking for existing sessions…</p>}

        {phase.step === 'choosing-session' && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Found {phase.sessions.length} existing session{phase.sessions.length === 1 ? '' : 's'} in{' '}
              {phase.project.displayName}
            </p>
            <ul className="space-y-1 max-h-64 overflow-y-auto">
              {phase.sessions.map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    onClick={() =>
                      callDaemon('adopt_session', { projectPath: phase.project.path, sessionId: session.sessionId })
                        .then((result) => {
                          const { id } = result as { id: string; status: string };
                          onStarted(id);
                        })
                        .catch(() => {
                          // Falls back to the fresh-start prompt on a failed adopt, same fail-toward-
                          // actionable-state reasoning used throughout this app — never leaves the user
                          // stuck on a dead-end tap.
                          setPhase({ step: 'prompting', project: phase.project });
                        })
                    }
                    className="w-full text-left rounded-md bg-panel hover:bg-border px-3 py-2"
                  >
                    <span className="font-medium">{session.summary}</span>
                    <p className="text-xs text-ink-faint truncate">{session.firstPrompt}</p>
                    <p className="text-xs text-ink-muted">Last active {formatRelativeTime(session.lastModified)}</p>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setPhase({ step: 'prompting', project: phase.project })}
              className="w-full text-left rounded-md bg-panel hover:bg-border px-3 py-2 text-sm text-ink-muted underline"
            >
              Start a new session instead
            </button>
          </div>
        )}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/StartSessionSheet.test.tsx
```
Expected: PASS — all 5 new tests, plus every pre-existing test in this file (the empty-result
case exercises the exact same "skip straight to prompting" path the pre-existing tests already
relied on implicitly, now made explicit by `handleSelectProject`'s discovery call).

- [ ] **Step 5: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; web gains 5 new passing tests; typecheck clean across all 4 packages.

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/web/src/StartSessionSheet.tsx packages/web/src/StartSessionSheet.test.tsx
git commit -m "web: surface discoverable sessions in the start-session sheet, folded into the existing flow"
```

---

## Task 7: Web — render `adopted_history` in `ActivityFeed`

**Files:**
- Modify: `packages/web/src/ActivityFeed.tsx`
- Modify: `packages/web/src/ActivityFeed.test.tsx`

**Interfaces:**
- Consumes: `adopted_history` `SessionEvent` (Task 1).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Read `packages/web/src/ActivityFeed.tsx` and `ActivityFeed.test.tsx` in full first. The
current file renders every event as one line of text via a `describeEvent(event): string`
exhaustive switch — a shape that cannot represent `adopted_history`'s array of prior messages
plus a truncation flag as a single line. This task changes `ActivityFeed`'s `.map()` to
special-case `adopted_history` with a dedicated sub-component, while every other event
continues through the existing `describeEvent` path unchanged.

Add to `packages/web/src/ActivityFeed.test.tsx`:

```typescript
it('renders an adopted_history event as an expanded "Prior conversation" block', () => {
  render(
    <ActivityFeed
      events={[
        {
          type: 'adopted_history',
          sessionId: 's1',
          originalSessionId: 'orig-1',
          messages: [
            { role: 'user', text: 'fix the bug in auth.ts' },
            { role: 'assistant', text: 'Found it — the token check was inverted.' },
          ],
          truncated: false,
          at: Date.now(),
        },
      ]}
    />
  );

  expect(screen.getByText(/prior conversation/i)).toBeInTheDocument();
  expect(screen.getByText('fix the bug in auth.ts')).toBeInTheDocument();
  expect(screen.getByText('Found it — the token check was inverted.')).toBeInTheDocument();
});

it('shows a truncation notice when the history was capped', () => {
  render(
    <ActivityFeed
      events={[
        {
          type: 'adopted_history',
          sessionId: 's1',
          originalSessionId: 'orig-1',
          messages: [{ role: 'user', text: 'hello' }],
          truncated: true,
          at: Date.now(),
        },
      ]}
    />
  );

  expect(screen.getByText(/showing the most recent 50 messages/i)).toBeInTheDocument();
});

it('does not show a truncation notice when the history was not capped', () => {
  render(
    <ActivityFeed
      events={[
        {
          type: 'adopted_history',
          sessionId: 's1',
          originalSessionId: 'orig-1',
          messages: [{ role: 'user', text: 'hello' }],
          truncated: false,
          at: Date.now(),
        },
      ]}
    />
  );

  expect(screen.queryByText(/showing the most recent 50 messages/i)).not.toBeInTheDocument();
});

it('renders adopted_history alongside normal events in the same feed', () => {
  render(
    <ActivityFeed
      events={[
        { type: 'adopted_history', sessionId: 's1', originalSessionId: 'orig-1', messages: [{ role: 'user', text: 'hi' }], truncated: false, at: Date.now() },
        { type: 'assistant_text', sessionId: 's1', text: 'How can I help?', at: Date.now() },
      ]}
    />
  );

  expect(screen.getByText(/prior conversation/i)).toBeInTheDocument();
  expect(screen.getByText('How can I help?')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/ActivityFeed.test.tsx
```
Expected: FAIL — `adopted_history` isn't a recognized case in `describeEvent`'s switch (a
TypeScript error on the exhaustiveness check, surfaced by Vitest's esbuild transform, since the
protocol's `SessionEvent` union now includes it per Task 1) and no "Prior conversation" text is
rendered anywhere.

- [ ] **Step 3: Implement**

In `packages/web/src/ActivityFeed.tsx`, add a dedicated rendering component (above
`ActivityFeed` or below it — either is fine, but keep it in this file rather than a new one,
matching this file's current single-file scope):

```typescript
function AdoptedHistoryBlock({ event }: { event: Extract<SessionEvent, { type: 'adopted_history' }> }) {
  return (
    <div className="space-y-1 border-l-2 border-border pl-2">
      <p className="text-xs font-medium text-ink-faint uppercase tracking-wide">Prior conversation</p>
      {event.truncated && (
        <p className="text-xs text-ink-faint italic">Showing the most recent 50 messages of a longer conversation</p>
      )}
      <ul className="space-y-1">
        {event.messages.map((message, index) => (
          <li key={index} className="text-sm text-ink-muted">
            <span className="font-medium">{message.role === 'user' ? 'You' : 'Claude'}:</span> {message.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Update the `.map()` in `ActivityFeed` to special-case `adopted_history`, rendering
`AdoptedHistoryBlock` instead of calling `describeEvent` for it:

```typescript
      {events.map((event, index) => (
        <li key={index} className="text-sm bg-panel rounded-md px-3 py-2">
          {event.type === 'adopted_history' ? <AdoptedHistoryBlock event={event} /> : describeEvent(event)}
        </li>
      ))}
```

Add a case to `describeEvent`'s switch for type-exhaustiveness (this branch is never actually
reached at runtime — the `.map()`'s ternary above always intercepts `adopted_history` first —
but the switch's own `: string` return type requires every `SessionEvent['type']` to be
handled, so this keeps that guard meaningful for every *other* future event type added later):

```typescript
    case 'adopted_history':
      // Never reached — the .map() above renders AdoptedHistoryBlock for this type before
      // describeEvent is ever called on it. Exists only so this switch stays exhaustive.
      return `Resumed from an earlier session (${event.messages.length} prior messages)`;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/ActivityFeed.test.tsx
```
Expected: PASS — all 4 new tests, plus every pre-existing test in this file.

- [ ] **Step 5: Full verification gate**

```bash
cd /d/Companion && npm run build && npm test && npm run typecheck
```
Expected: build clean; web gains 4 new passing tests; typecheck clean across all 4 packages.

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/web/src/ActivityFeed.tsx packages/web/src/ActivityFeed.test.tsx
git commit -m "web: render adopted_history events as a Prior conversation block in the activity feed"
```

---

## Final whole-branch review

After Task 7, dispatch the final code reviewer (per subagent-driven-development's process) over
the full branch diff against `master`. Point it explicitly at:

- **The `forkSession`/`resumeSessionId` gating** (Task 2) — re-verify, against the final tree,
  that `forkSession` is genuinely never set `true` on a normal fresh `start()` call (no
  `resumeSessionId` present) by tracing `real-agent-sdk.ts`'s actual shipped code, not by
  trusting this plan's description of it.
- **The history-cap slicing direction** (Task 3) — re-verify `messages.slice(-HISTORY_MESSAGE_CAP)`
  actually keeps the *most recent* messages (not the oldest) by reading the shipped code and,
  ideally, tracing back to the SDK's own "chronological order" doc comment for
  `getSessionMessages` cited in this plan's Global Constraints.
- **The re-validation discipline in `adopt_session`** (Task 5) — confirm it re-derives both
  `projectPath` validity AND session discoverability fresh on every call, never trusting an
  earlier `list_discoverable_sessions` response from the same phone session, mirroring
  `start_session`'s existing re-validation of `projectPath`.
- **Every `new SessionRunner(...)` and `new SessionManager(...)` construction across the full
  daemon package** (not just the files this plan named) — grep the entire `packages/daemon/src`
  tree for both, and confirm every one supplies `getSessionMessagesFn`. This exact class of gap
  (a required-option addition missing from a test file the plan's own file list didn't
  anticipate) was found twice during the prior `remote-session-start` project in this same
  repo — once by an implementer, once by a reviewer who had to independently verify a fix.
- **The relay-changes-are-zero claim** (spec's own explicit finding) — confirm no file under
  `packages/relay/src` appears in the branch's diff at all. If one does, that's a scope
  deviation from the approved spec worth flagging, not necessarily wrong, but worth an explicit
  ruling on why.
