# Remote Session Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user start a brand-new Claude Code session from their phone — safely, through the existing device-scoped RPC channel — and redesign the mobile screens this touches (session list, start-session flow, Settings) so the phone is genuinely the best way to work, not a secondary remote control.

**Architecture:** Two new daemon RPC methods (`list_projects`, `start_session`) added to the existing method registry from reliable-transport's Task 6 — no relay routing changes needed, since that channel is already generic per-method. The daemon gains a persisted "known projects" list, a real concurrency cap (replacing today's hard one-session-at-a-time gate), and a fix for a verified memory leak this feature would otherwise make much worse. The relay's daemon-status endpoint grows to report live connection state. The web app gets a project-picker "start a session" sheet, a redesigned session list, and a corrected Settings screen (its current "Pair a daemon" form has no conditional around it at all and always renders, even when a daemon is already paired — confirmed by reading the file).

**Tech Stack:** TypeScript, Zod, Express, `ws`, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-remote-session-start-design.md`

## Global Constraints

- **Losing typed input is still the worst failure this app can have.** Applies directly to `StartSessionSheet`'s error path: a failed submit must never discard the prompt the user typed.
- **`COMPANION_PROJECTS_ROOT` is one directory, not a list.** Explicit YAGNI call in the spec — do not build multi-root support.
- **Never invent a "last seen" timestamp for a disconnected daemon.** The app does not track one anywhere; do not imply it does in any UI copy.
- **`INVALID_PROJECT_PATH` deliberately covers three causes** (not in known history, not under the configured root, no longer exists on disk) **with one error code.** The remedy is identical from the caller's side — do not split this into more specific codes.
- **Non-goals, explicitly out of scope for every task in this plan:** multiple configured project roots; a disconnected-daemon last-seen timestamp; anything about adopting sessions started entirely outside Companion (separate future work); renaming or managing the filesystem from the phone.
- **Baseline test status as of this branch (`remote-session-start`, off `master` at `dc04e43`, zero code diff from `master`):** daemon 126 passed + 1 skipped, protocol 63 passed, web 223 passed — all reliably green. Relay: 298 passed, but `postgres-store.test.ts`'s claim-failure/lockout tests are **known-flaky against the remote Neon test database** — confirmed non-deterministic by running twice (7 failures the first run, 3 different failures the second, all `Test timed out in 5000ms`, none touching code this plan changes). **Do not attempt to fix this flakiness as part of any task in this plan.** If a task's own new or modified tests fail, that is real and must be fixed; an unrelated `postgres-store.test.ts` timeout is not.
- **Relay tests `TRUNCATE` a shared database: never run two relay test suites concurrently.**
- Relay Postgres tests need `COMPANION_TEST_DATABASE_URL`, already set in the gitignored `packages/relay/.env`. Never read, print, echo, or commit `.env` contents; never point that variable at `DATABASE_URL`.
- Run the Bash tool's working directory explicitly (`cd /d/Companion && ...` or absolute paths) for every command in this plan — a prior `cd` into a package subdirectory silently strands later commands there, producing a misleadingly small "passing" count from `npm test`.

---

### Task 1: Protocol — new RPC error codes, and the web-side message map they require

**Closes:** the two new failure modes `start_session` needs (spec's Protocol changes section). Also fixes a coupling every later task depends on: `RPC_ERROR_MESSAGES` in `packages/web/src/relay-connection.ts` is typed `Record<RpcErrorCode, string>` — an **exhaustive** map (confirmed by reading the file). Adding codes to the protocol without adding matching entries there breaks the web package's typecheck immediately, not just at runtime.

**Files:**
- Modify: `packages/protocol/src/rpc-errors.ts`
- Test: `packages/protocol/src/rpc-errors.test.ts`
- Modify: `packages/web/src/relay-connection.ts` (the `RPC_ERROR_MESSAGES` map only — do not touch anything else in this file)

**Interfaces:**
- Produces: `RPC_ERROR_CODES.INVALID_PROJECT_PATH = 'invalid_project_path'`, `RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT = 'concurrent_session_limit'` — every later daemon/web task imports these by name, never the raw string.

- [ ] **Step 1: Read the current file to match its exact style**

Read `packages/protocol/src/rpc-errors.ts` in full — every existing code has a doc comment explaining *when* it fires, not just what it means. Match that.

- [ ] **Step 2: Write the failing test**

Add to `packages/protocol/src/rpc-errors.test.ts` (create it with this content if it doesn't already cover this shape — check the existing file first and add to its existing `describe` block):

```typescript
it('includes the new session-start error codes', () => {
  expect(RPC_ERROR_CODES.INVALID_PROJECT_PATH).toBe('invalid_project_path');
  expect(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT).toBe('concurrent_session_limit');
});
```

- [ ] **Step 3: Run it, confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/protocol packages/protocol/src/rpc-errors.test.ts
```
Expected: FAIL — `RPC_ERROR_CODES.INVALID_PROJECT_PATH` is `undefined`.

- [ ] **Step 4: Add the two codes**

In `packages/protocol/src/rpc-errors.ts`, add inside the `RPC_ERROR_CODES` object (after `HANDLER_ERROR`, before `NOT_CONNECTED` — order doesn't matter functionally, but keeping the two new session-start-specific codes adjacent to each other is clearer for the next reader):

```typescript
  /** The `start_session` caller gave a `projectPath` that is not in the daemon's known project
   * history, not under its configured `COMPANION_PROJECTS_ROOT` (if one is set), or no longer
   * exists on disk. One code covers all three causes: the remedy is identical from the caller's
   * side (re-list, pick again), and splitting them risks leaking filesystem structure for no
   * actionable benefit. */
  INVALID_PROJECT_PATH: 'invalid_project_path',
  /** The daemon already has `maxConcurrentSessions` non-stopped sessions running; `start_session`
   * refuses to start another until one stops. See `SessionManager`'s concurrency cap. */
  CONCURRENT_SESSION_LIMIT: 'concurrent_session_limit',
```

- [ ] **Step 5: Run it, confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/protocol packages/protocol/src/rpc-errors.test.ts
```
Expected: PASS.

- [ ] **Step 6: Update the web-side exhaustive message map**

Read `packages/web/src/relay-connection.ts` around its `RPC_ERROR_MESSAGES` constant. Add two entries, matching the existing ones' tone (short, human, no jargon):

```typescript
  [RPC_ERROR_CODES.INVALID_PROJECT_PATH]: "That project folder couldn't be found. It may have moved or been deleted — try picking again.",
  [RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT]: "You've reached the limit of concurrent sessions. Stop one before starting another.",
```

- [ ] **Step 7: Confirm the whole monorepo still builds and tests pass**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; test counts match the Global Constraints baseline plus this task's one new passing test (protocol 64 passed). The relay's `postgres-store.test.ts` flakiness (if it occurs) is not this task's concern — do not investigate it here.

- [ ] **Step 8: Commit**

```bash
cd /d/Companion && git add packages/protocol/src/rpc-errors.ts packages/protocol/src/rpc-errors.test.ts packages/web/src/relay-connection.ts
git commit -m "protocol: add invalid_project_path and concurrent_session_limit RPC error codes"
```

---

### Task 2: Daemon — persisted known-projects store

**Closes:** the spec's `project-store.ts` requirement — the daemon needs to remember which paths it has started sessions in before, surviving process restarts.

**Files:**
- Create: `packages/daemon/src/project-store.ts`
- Test: `packages/daemon/src/project-store.test.ts`

**Interfaces:**
- Consumes: nothing from this plan's other tasks.
- Produces: `recordProjectUsed(path: string, options: { filePath: string; now?: () => number }): Promise<void>` and `listKnownProjects(options: { filePath: string }): Promise<{ path: string; lastUsedAt: number }[]>` — Task 3 (SessionManager) calls `recordProjectUsed`; Task 4 (RPC handlers) calls `listKnownProjects`.

**Context — the exact pattern to mirror:** `packages/daemon/src/device-auth.ts` already persists a small JSON credential file the same way this needs to: `mkdir(dirname(path), { recursive: true })` then `writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 })`, and reads with a try/catch on `readFile` that treats `ENOENT` as "nothing yet" rather than an error. Follow that file's structure exactly — read it in full before writing this one.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/project-store.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordProjectUsed, listKnownProjects } from './project-store.js';

let tempDir: string | undefined;

async function makeTempFilePath(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'companion-project-store-test-'));
  return join(tempDir, 'daemon-projects.json');
}

describe('project-store', () => {
  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('listKnownProjects returns an empty array when the file does not exist yet', async () => {
    const filePath = await makeTempFilePath();
    expect(await listKnownProjects({ filePath })).toEqual([]);
  });

  it('recordProjectUsed then listKnownProjects returns the recorded path with its timestamp', async () => {
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/my-project', { filePath, now: () => 1000 });

    expect(await listKnownProjects({ filePath })).toEqual([{ path: '/tmp/my-project', lastUsedAt: 1000 }]);
  });

  it('recordProjectUsed on an existing path updates its lastUsedAt rather than duplicating the entry', async () => {
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/my-project', { filePath, now: () => 1000 });
    await recordProjectUsed('/tmp/my-project', { filePath, now: () => 2000 });

    expect(await listKnownProjects({ filePath })).toEqual([{ path: '/tmp/my-project', lastUsedAt: 2000 }]);
  });

  it('recordProjectUsed on a new path adds it alongside existing entries', async () => {
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/project-a', { filePath, now: () => 1000 });
    await recordProjectUsed('/tmp/project-b', { filePath, now: () => 2000 });

    const result = await listKnownProjects({ filePath });
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ path: '/tmp/project-a', lastUsedAt: 1000 });
    expect(result).toContainEqual({ path: '/tmp/project-b', lastUsedAt: 2000 });
  });

  it('throws a clear error if the file exists but is not valid JSON', async () => {
    const filePath = await makeTempFilePath();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not json', { mode: 0o600 });

    await expect(listKnownProjects({ filePath })).rejects.toThrow(/malformed/i);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/project-store.test.ts
```
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `project-store.ts`**

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface KnownProject {
  path: string;
  lastUsedAt: number;
}

interface ProjectStoreFile {
  projects: KnownProject[];
}

/**
 * Persists the daemon's "projects it has started a session in before" list to a small JSON file
 * — same pattern as device-auth.ts's device-token file, including the 0o600 permission: a
 * project path list reveals filesystem structure on this machine, so it gets the same
 * owner-only-read treatment as the credential file does.
 */
async function readFileOrEmpty(filePath: string): Promise<ProjectStoreFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Project store file at ${filePath} is malformed`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as ProjectStoreFile).projects)
  ) {
    throw new Error(`Project store file at ${filePath} is malformed`);
  }
  return parsed as ProjectStoreFile;
}

async function writeFileAtomicish(filePath: string, data: ProjectStoreFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function listKnownProjects(options: { filePath: string }): Promise<KnownProject[]> {
  const data = await readFileOrEmpty(options.filePath);
  return data.projects;
}

/**
 * Upserts `path` with `lastUsedAt = now()` — updates the existing entry's timestamp if `path` is
 * already known, otherwise appends a new one. Called from `SessionManager.startSession` as the
 * single choke point both the local HTTP surface and the remote RPC `start_session` handler go
 * through, so a project's history is recorded correctly regardless of which door started it.
 */
export async function recordProjectUsed(
  path: string,
  options: { filePath: string; now?: () => number }
): Promise<void> {
  const now = options.now ?? Date.now;
  const data = await readFileOrEmpty(options.filePath);
  const existing = data.projects.find((p) => p.path === path);
  if (existing) {
    existing.lastUsedAt = now();
  } else {
    data.projects.push({ path, lastUsedAt: now() });
  }
  await writeFileAtomicish(options.filePath, data);
}
```

- [ ] **Step 4: Run it, confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/project-store.test.ts
```
Expected: PASS, all 6 tests.

- [ ] **Step 5: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; daemon's count grows by 6 (132 passed + 1 skipped).

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/project-store.ts packages/daemon/src/project-store.test.ts
git commit -m "daemon: persist a known-projects list across restarts"
```

---

### Task 3: Daemon — SessionManager concurrency cap, verified leak fix, and project-history wiring

**Closes:** the spec's `SessionManager` redesign — removes the hard one-session gate, adds a real cap, and fixes a confirmed memory leak (stopped sessions were never removed from the internal map, only excluded from the old single-active-session pointer — harmless when sessions were rare and manual, a real growing leak once this feature makes starting sessions frequent and phone-driven).

**Files:**
- Modify: `packages/daemon/src/session-manager.ts`
- Modify: `packages/daemon/src/session-manager.test.ts`

**Interfaces:**
- Consumes: `recordProjectUsed` from `packages/daemon/src/project-store.js` (Task 2).
- Produces: `SessionManagerOptions` gains `maxConcurrentSessions?: number` (default `DEFAULT_MAX_CONCURRENT_SESSIONS = 3`, exported) and `projectStoreFilePath: string` (required — no default inside this class; the caller, `main.ts` in Task 4, supplies it). `getActiveSession()` and the `activeSessionId` field are **removed entirely** — confirmed by reading `command-dispatcher.ts` in full that nothing outside this class's own tests uses them; every real dispatch path already looks sessions up by explicit id.

**Context you need before touching this file:** read the current `packages/daemon/src/session-manager.ts` (69 lines) and `packages/daemon/src/session-manager.test.ts` (99 lines, 6 tests) in full first. Every one of the 6 existing tests references `getActiveSession()`, which this task removes — all 6 need rewriting, not just the two that mention "active" in their names.

- [ ] **Step 1: Replace the test file's TDD-relevant tests first (write them failing, against the not-yet-changed class)**

Replace `packages/daemon/src/session-manager.test.ts` in full with:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createMockQueryFn(): QueryFn {
  return () => {
    const outgoing = new AsyncQueue<AgentMessage>();
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => outgoing.close()),
    };
    return agentQuery;
  };
}

async function makeManager(overrides: { maxConcurrentSessions?: number } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
  const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
  const manager = new SessionManager({
    queryFn: createMockQueryFn(),
    onEvent: () => {},
    projectStoreFilePath,
    ...overrides,
  });
  return { manager, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
}

describe('SessionManager', () => {
  it('starts a session and it is retrievable via getSession', async () => {
    const { manager, cleanup } = await makeManager();
    try {
      const runner = manager.startSession('/tmp/project', 'do the thing');
      expect(manager.getSession(runner.id)).toBe(runner);
    } finally {
      await cleanup();
    }
  });

  it('throws when looking up an unknown session id', async () => {
    const { manager, cleanup } = await makeManager();
    try {
      expect(() => manager.getSession('does-not-exist')).toThrow();
    } finally {
      await cleanup();
    }
  });

  it('allows starting sessions up to maxConcurrentSessions', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 2 });
    try {
      const first = manager.startSession('/tmp/project-a', 'first');
      const second = manager.startSession('/tmp/project-b', 'second');
      expect(manager.getSession(first.id)).toBe(first);
      expect(manager.getSession(second.id)).toBe(second);
    } finally {
      await cleanup();
    }
  });

  it('throws when starting one more than maxConcurrentSessions', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 2 });
    try {
      manager.startSession('/tmp/project-a', 'first');
      manager.startSession('/tmp/project-b', 'second');
      expect(() => manager.startSession('/tmp/project-c', 'third')).toThrow();
    } finally {
      await cleanup();
    }
  });

  it('a stopped session no longer counts toward the cap, and is removed from the manager entirely', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 1 });
    try {
      const first = manager.startSession('/tmp/project', 'first');
      await manager.stopSession(first.id);

      // Removed, not merely excluded from the cap count: looking it up now throws.
      expect(() => manager.getSession(first.id)).toThrow();

      // And the freed cap slot is real, not just a count that happens to be right.
      const second = manager.startSession('/tmp/project', 'second');
      expect(manager.getSession(second.id)).toBe(second);
    } finally {
      await cleanup();
    }
  });

  it('unwinds on a synchronous runner.start() failure, and does not count the failed attempt toward the cap', async () => {
    let callCount = 0;
    const flakyQueryFn: QueryFn = (args) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('bad cwd');
      }
      return createMockQueryFn()(args);
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
    const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
    const manager = new SessionManager({
      queryFn: flakyQueryFn,
      onEvent: () => {},
      projectStoreFilePath,
      maxConcurrentSessions: 1,
    });
    try {
      expect(() => manager.startSession('/tmp/project', 'first')).toThrow('bad cwd');

      const second = manager.startSession('/tmp/project', 'second');
      expect(manager.getSession(second.id)).toBe(second);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('a crash-terminated session is removed from the manager without an explicit stopSession call', async () => {
    const crashingQueryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crashed')),
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    const events: SessionEvent[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
    const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
    const manager = new SessionManager({
      queryFn: crashingQueryFn,
      onEvent: (e) => events.push(e),
      projectStoreFilePath,
    });
    try {
      const runner = manager.startSession('/tmp/project', 'do the thing');
      expect(manager.getSession(runner.id)).toBe(runner);

      // Let the crash propagate through drainMessages' catch/finalize path.
      await new Promise((resolve) => setImmediate(resolve));

      expect(() => manager.getSession(runner.id)).toThrow();
      expect(events.some((e) => e.type === 'stopped')).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('records the project path as used on a successful start', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
    const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
    const manager = new SessionManager({
      queryFn: createMockQueryFn(),
      onEvent: () => {},
      projectStoreFilePath,
    });
    try {
      manager.startSession('/tmp/my-project', 'do the thing');
      // Let the fire-and-forget record settle.
      await new Promise((resolve) => setImmediate(resolve));

      const { listKnownProjects } = await import('./project-store.js');
      const known = await listKnownProjects({ filePath: projectStoreFilePath });
      expect(known.map((p) => p.path)).toContain('/tmp/my-project');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/session-manager.test.ts
```
Expected: FAIL — `SessionManagerOptions` doesn't accept `projectStoreFilePath`/`maxConcurrentSessions` yet, and the old single-session throw message doesn't match the new cap tests' expectations.

- [ ] **Step 3: Rewrite `session-manager.ts`**

Replace the file in full:

```typescript
import { randomUUID } from 'node:crypto';
import { SessionRunner } from './session-runner.js';
import type { QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';
import { recordProjectUsed } from './project-store.js';

/** Default cap on non-stopped sessions this daemon will run at once, if `main.ts` doesn't
 * override it from `COMPANION_MAX_CONCURRENT_SESSIONS`. Chosen to comfortably cover normal
 * multi-project use while still bounding worst-case resource/API cost from a client that starts
 * many sessions without stopping any — same reasoning as this project's other bounded caps
 * (RPC_IN_FLIGHT_CAP_PER_DEVICE in the relay's hub.ts). */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

export interface SessionManagerOptions {
  queryFn: QueryFn;
  onEvent: (event: SessionEvent) => void;
  /** Where the known-projects list is persisted — see project-store.ts. Required, not defaulted
   * here: the daemon's actual path (~/.companion/daemon-projects.json by default, overridable via
   * COMPANION_PROJECTS_FILE_PATH) is main.ts's concern, not this class's. */
  projectStoreFilePath: string;
  maxConcurrentSessions?: number;
}

export class SessionManager {
  private readonly queryFn: QueryFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private readonly projectStoreFilePath: string;
  private readonly maxConcurrentSessions: number;
  private sessions = new Map<string, SessionRunner>();

  constructor(options: SessionManagerOptions) {
    this.queryFn = options.queryFn;
    this.onEvent = options.onEvent;
    this.projectStoreFilePath = options.projectStoreFilePath;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  }

  /** Count of sessions currently occupying a concurrency slot. A stopped session is removed from
   * `this.sessions` entirely (see the `onEvent` wrapper below), so this is simply the map's
   * size — no separate status filter needed. */
  private activeCount(): number {
    return this.sessions.size;
  }

  startSession(projectPath: string, prompt: string): SessionRunner {
    if (this.activeCount() >= this.maxConcurrentSessions) {
      throw new Error(
        `Cannot start a new session: already at the limit of ${this.maxConcurrentSessions} concurrent sessions.`
      );
    }
    const id = randomUUID();
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      onEvent: (event) => {
        // A stopped session is removed here, not merely excluded from some separate "active" set.
        // Before this fix, SessionManager never removed a finished session from `this.sessions` at
        // all — only a single-session "active pointer" was cleared, so the SessionRunner (and
        // everything it holds) stayed reachable, and therefore in memory, for the rest of the
        // daemon process's lifetime. That was rarely hit when starting a session was a rare,
        // manual, one-at-a-time act; this feature makes it frequent and phone-driven, turning the
        // same latent leak into a real one — and hitting hardest the users who use it most. Nothing
        // else needs a stopped session's runner reachable afterward: stopSession looks it up
        // *before* stopping (not after), every other daemon-side operation already refuses to act
        // on a stopped session, and session history is served from the relay's durable store, not
        // from this in-memory map.
        if (event.type === 'stopped') {
          this.sessions.delete(id);
        }
        this.onEvent(event);
      },
    });
    this.sessions.set(id, runner);
    try {
      runner.start(prompt);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    // Fire-and-forget: recording project history must never block or fail session startup — a
    // disk write hiccup here is not a reason to refuse to start a session the caller already
    // committed to.
    void recordProjectUsed(projectPath, { filePath: this.projectStoreFilePath }).catch(() => {});
    return runner;
  }

  getSession(id: string): SessionRunner {
    const runner = this.sessions.get(id);
    if (!runner) throw new Error(`No session with id ${id}`);
    return runner;
  }

  async stopSession(id: string): Promise<void> {
    const runner = this.getSession(id);
    await runner.stop();
  }
}
```

- [ ] **Step 4: Run it, confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/session-manager.test.ts
```
Expected: PASS, all 8 tests.

- [ ] **Step 5: Fix every other file that referenced the removed `getActiveSession()`**

```bash
cd /d/Companion && grep -rn "getActiveSession\|activeSessionId" packages/daemon/src --include=*.ts
```
This should now only find matches inside `session-manager.ts` itself if any remain (there should be none — re-check the rewritten file above has no leftover references) and inside `session-runner.ts` if it independently tracks its own status (it does, via `SessionRunner.status`, which is unrelated and untouched by this task). If the grep finds a reference in `http-server.ts`, `command-dispatcher.ts`, or `main.ts`, stop and report — the spec's verification found none, but confirm this is still true against the current tree before proceeding, since another task landing first could theoretically have changed something.

- [ ] **Step 6: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean. `daemon` package will show a build error at this point from `main.ts` (Task 4 hasn't updated its `SessionManager` construction call yet to supply the now-required `projectStoreFilePath`) — **this is expected and acceptable to leave broken across Task 3/4's boundary only if Task 4 is dispatched immediately after**; if there will be any gap, add the minimal fix to `main.ts`'s existing `new SessionManager({...})` call right now: add `projectStoreFilePath: DEVICE_TOKEN_PATH.replace('daemon-device.json', 'daemon-projects.json')` as a temporary literal (Task 4 replaces this with the real env-var-driven path). Confirm `npm run build` is clean before committing either way — a red build must never be committed.

- [ ] **Step 7: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/session-manager.ts packages/daemon/src/session-manager.test.ts packages/daemon/src/main.ts
git commit -m "daemon: replace the single-session gate with a real concurrency cap, fix a stopped-session memory leak"
```

---

### Task 4: Daemon — `list_projects` and `start_session` RPC handlers, env var wiring

**Closes:** the spec's daemon RPC contract — the actual methods a phone calls.

**Files:**
- Modify: `packages/daemon/src/rpc-handlers.ts`
- Modify: `packages/daemon/src/rpc-handlers.test.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/README.md`

**Interfaces:**
- Consumes: `RPC_ERROR_CODES.INVALID_PROJECT_PATH` / `CONCURRENT_SESSION_LIMIT` (Task 1); `listKnownProjects` (Task 2); `SessionManager` with its new `startSession` cap-throw behavior (Task 3).
- Produces: `REGISTRY['list_projects']` and `REGISTRY['start_session']` — nothing later in this plan calls these directly (the web side goes through `callDaemon('list_projects')` / `callDaemon('start_session', ...)`, which only needs the method *names* as strings, defined here as the contract).

**Context:** read the current `packages/daemon/src/rpc-handlers.ts` (69 lines) and `packages/daemon/src/main.ts` (245 lines) in full first. `RpcHandlerDeps` currently carries only `version`/`startedAt`/`now` — it needs to grow to carry what these two new handlers need: the `SessionManager` instance, the project-store file path, and the optional projects-root directory.

- [ ] **Step 1: Write the failing tests**

Add to `packages/daemon/src/rpc-handlers.test.ts` (read the existing file first to match its structure — it tests `dispatchRpc` against an injectable `registry` override for the "handler throws" case; follow that same pattern of constructing real deps with a temp directory):

```typescript
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './session-manager.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';
import { recordProjectUsed } from './project-store.js';

function createMockQueryFn(): QueryFn {
  return () => {
    const outgoing = new AsyncQueue<AgentMessage>();
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt: async () => {},
      close: () => outgoing.close(),
    };
    return agentQuery;
  };
}

describe('rpc-handlers: list_projects / start_session', () => {
  it('list_projects returns known projects sorted most-recently-used first', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    try {
      await recordProjectUsed('/tmp/older', { filePath, now: () => 1000 });
      await recordProjectUsed('/tmp/newer', { filePath, now: () => 2000 });
      const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toEqual([
        { path: '/tmp/newer', displayName: 'newer', source: 'history', lastUsedAt: 2000 },
        { path: '/tmp/older', displayName: 'older', source: 'history', lastUsedAt: 1000 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('list_projects excludes a known path that no longer exists on disk', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const realProjectDir = join(tempDir, 'still-here');
    await mkdir(realProjectDir);
    try {
      await recordProjectUsed(realProjectDir, { filePath, now: () => 1000 });
      await recordProjectUsed('/tmp/deleted-project-path-does-not-exist', { filePath, now: () => 2000 });
      const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      const paths = (outcome.result as { path: string }[]).map((p) => p.path);
      expect(paths).toEqual([realProjectDir]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('list_projects includes subdirectories of projectsRoot with source "configured" when never used', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectsRoot = join(tempDir, 'root');
    await mkdir(join(projectsRoot, 'brand-new-project'), { recursive: true });
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot,
      });

      expect(outcome.result).toEqual([
        {
          path: join(projectsRoot, 'brand-new-project'),
          displayName: 'brand-new-project',
          source: 'configured',
          lastUsedAt: undefined,
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('a path both in history and under projectsRoot is reported once, as "history"', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectsRoot = join(tempDir, 'root');
    const usedProjectDir = join(projectsRoot, 'used-project');
    await mkdir(usedProjectDir, { recursive: true });
    try {
      await recordProjectUsed(usedProjectDir, { filePath, now: () => 1000 });
      const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot,
      });

      expect(outcome.result).toEqual([
        { path: usedProjectDir, displayName: 'used-project', source: 'history', lastUsedAt: 1000 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session starts a session for a path in the known/allowed set and returns its id and status', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectDir = join(tempDir, 'allowed-project');
    await mkdir(projectDir);
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('start_session', { projectPath: projectDir, prompt: 'hello' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.error).toBeUndefined();
      const result = outcome.result as { id: string; status: string };
      expect(typeof result.id).toBe('string');
      expect(result.status).toBe('running');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session rejects a path that is not known and not under projectsRoot with INVALID_PROJECT_PATH', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('start_session', { projectPath: '/tmp/never-seen-this-path', prompt: 'hello' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toBe(RPC_ERROR_CODES.INVALID_PROJECT_PATH);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session rejects with CONCURRENT_SESSION_LIMIT once the daemon is at its cap', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectDir = join(tempDir, 'allowed-project');
    await mkdir(projectDir);
    try {
      const manager = new SessionManager({
        queryFn: createMockQueryFn(),
        onEvent: () => {},
        projectStoreFilePath: filePath,
        maxConcurrentSessions: 1,
      });
      manager.startSession(projectDir, 'first');

      const outcome = await dispatchRpc('start_session', { projectPath: projectDir, prompt: 'second' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toBe(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/rpc-handlers.test.ts
```
Expected: FAIL — `list_projects`/`start_session` aren't registered, and `RpcHandlerDeps` doesn't accept `manager`/`projectStoreFilePath`/`projectsRoot`.

- [ ] **Step 3: Implement the handlers**

In `packages/daemon/src/rpc-handlers.ts`, extend `RpcHandlerDeps` and `REGISTRY`:

```typescript
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { RPC_ERROR_CODES, type RpcErrorCode } from '@companion/protocol';
import type { SessionManager } from './session-manager.js';
import { listKnownProjects } from './project-store.js';

export interface RpcHandlerDeps {
  version: string;
  startedAt: number;
  now?: () => number;
  /** Needed by start_session to actually start one, and by list_projects/start_session's
   * cap-exceeded translation. */
  manager: SessionManager;
  /** Same path SessionManager was constructed with — list_projects reads it directly rather than
   * asking SessionManager for it, since the known-projects list is project-store's concern, not
   * SessionManager's. */
  projectStoreFilePath: string;
  /** COMPANION_PROJECTS_ROOT, if set. One directory; its immediate subdirectories are offered as
   * startable even with no session history. */
  projectsRoot: string | undefined;
}

export interface ProjectListEntry {
  path: string;
  displayName: string;
  source: 'history' | 'configured';
  lastUsedAt: number | undefined;
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * The merged, deduplicated, existence-filtered set of projects this daemon will accept a
 * start_session call for. Shared by both list_projects (reports it) and start_session (re-derives
 * it to validate against — never trusts a phone's earlier list call, since a path can vanish
 * between listing and starting).
 */
async function resolveKnownProjects(deps: RpcHandlerDeps): Promise<ProjectListEntry[]> {
  const known = await listKnownProjects({ filePath: deps.projectStoreFilePath });
  const historyPaths = new Set(known.map((p) => p.path));
  const entries: ProjectListEntry[] = [];

  for (const project of known) {
    if (await pathExistsAsDirectory(project.path)) {
      entries.push({
        path: project.path,
        displayName: basename(project.path),
        source: 'history',
        lastUsedAt: project.lastUsedAt,
      });
    }
  }

  if (deps.projectsRoot) {
    let rootEntries: string[] = [];
    try {
      const dirents = await readdir(deps.projectsRoot, { withFileTypes: true });
      rootEntries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      // Missing/unreadable COMPANION_PROJECTS_ROOT is a configuration issue for the operator to
      // notice locally (the daemon's own startup log is the right place for that — not here);
      // list_projects degrades to history-only rather than failing the whole RPC.
      rootEntries = [];
    }
    for (const name of rootEntries) {
      const fullPath = join(deps.projectsRoot, name);
      if (historyPaths.has(fullPath)) continue; // already included above as 'history'
      entries.push({ path: fullPath, displayName: name, source: 'configured', lastUsedAt: undefined });
    }
  }

  entries.sort((a, b) => {
    if (a.source === 'history' && b.source === 'history') return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
    if (a.source !== b.source) return a.source === 'history' ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  return entries;
}

interface StartSessionParams {
  projectPath: string;
  prompt: string;
}

function isStartSessionParams(params: unknown): params is StartSessionParams {
  return (
    typeof params === 'object' &&
    params !== null &&
    typeof (params as StartSessionParams).projectPath === 'string' &&
    typeof (params as StartSessionParams).prompt === 'string'
  );
}

const REGISTRY: Record<string, RpcHandler> = {
  ping: (_params, deps): PingResult => ({
    version: deps.version,
    uptimeMs: (deps.now ?? Date.now)() - deps.startedAt,
  }),
  list_projects: async (_params, deps) => resolveKnownProjects(deps),
  start_session: async (params, deps): Promise<{ id: string; status: string } | RpcOutcome> => {
    if (!isStartSessionParams(params)) {
      return { error: RPC_ERROR_CODES.INVALID_PROJECT_PATH } as unknown as { id: string; status: string };
    }
    const known = await resolveKnownProjects(deps);
    if (!known.some((p) => p.path === params.projectPath)) {
      throw Object.assign(new Error('invalid project path'), { rpcCode: RPC_ERROR_CODES.INVALID_PROJECT_PATH });
    }
    try {
      const runner = deps.manager.startSession(params.projectPath, params.prompt);
      return { id: runner.id, status: runner.status };
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        rpcCode: RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT,
      });
    }
  },
};
```

Update `dispatchRpc` to check for an `rpcCode` on a caught error, using it instead of the generic `HANDLER_ERROR` when present:

```typescript
export async function dispatchRpc(
  method: string,
  params: unknown,
  deps: RpcHandlerDeps,
  registry: Record<string, RpcHandler> = REGISTRY
): Promise<RpcOutcome> {
  const handler = registry[method];
  if (!handler) return { error: RPC_ERROR_CODES.UNKNOWN_METHOD };
  try {
    const result = await handler(params, deps);
    return { result: result === undefined ? null : result };
  } catch (err) {
    const rpcCode = (err as { rpcCode?: RpcErrorCode }).rpcCode;
    return { error: rpcCode ?? RPC_ERROR_CODES.HANDLER_ERROR };
  }
}
```

Note: the `start_session` handler above uses a thrown-error-with-`rpcCode` convention rather than directly returning `{error: ...}`, so both its failure paths (bad params, cap exceeded) flow through the same `dispatchRpc` catch site as every other handler's unexpected-throw path — keeping `dispatchRpc` the single place that decides what an outcome's wire shape is, per its own existing doc comment ("Never throws itself... translating every outcome"). Re-read that doc comment and adjust its wording if this changes what it accurately describes.

- [ ] **Step 4: Run it, confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/daemon packages/daemon/src/rpc-handlers.test.ts
```
Expected: PASS, all tests (existing `ping`/unknown-method/handler-throws tests plus the 7 new ones above).

- [ ] **Step 5: Wire the new env vars and deps into `main.ts`**

In `packages/daemon/src/main.ts`, alongside the existing env var reads near the top:

```typescript
const PROJECTS_ROOT = process.env.COMPANION_PROJECTS_ROOT;
const MAX_CONCURRENT_SESSIONS = Number(process.env.COMPANION_MAX_CONCURRENT_SESSIONS ?? DEFAULT_MAX_CONCURRENT_SESSIONS);
const PROJECTS_FILE_PATH =
  process.env.COMPANION_PROJECTS_FILE_PATH ?? join(homedir(), '.companion', 'daemon-projects.json');
```

Add the `DEFAULT_MAX_CONCURRENT_SESSIONS` import from `./session-manager.js` alongside the existing `SessionManager` import. Update the `SessionManager` construction (replacing whatever literal Task 3's Step 6 left in place, if that step was needed):

```typescript
  const manager = new SessionManager({
    queryFn: realQueryFn,
    onEvent: (event) => {
      eventLog.push(event);
      console.log(`[${event.sessionId}] ${event.type}`);
      relayClient?.sendEvent(event.sessionId, event);
    },
    projectStoreFilePath: PROJECTS_FILE_PATH,
    maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
  });
```

Update the `onRpcRequest` wiring to pass the new deps:

```typescript
          onRpcRequest: (method, params) =>
            dispatchRpc(method, params, {
              version: DAEMON_VERSION,
              startedAt: DAEMON_STARTED_AT,
              manager,
              projectStoreFilePath: PROJECTS_FILE_PATH,
              projectsRoot: PROJECTS_ROOT,
            }),
```

- [ ] **Step 6: Document the new env vars in the README**

In `packages/daemon/README.md`, in the existing `## Configuration` bullet list (after the existing `COMPANION_DEVICE_TOKEN_PATH` entry), add:

```markdown
- `COMPANION_PROJECTS_ROOT` — optional. A single directory whose immediate subdirectories become
  startable from the phone even with no prior session history there. One root only, not a list.
- `COMPANION_MAX_CONCURRENT_SESSIONS` — optional, default `3`. Upper bound on how many sessions
  this daemon runs at once.
- `COMPANION_PROJECTS_FILE_PATH` — where the daemon persists the list of projects it has started a
  session in before (default: `~/.companion/daemon-projects.json`).
```

- [ ] **Step 7: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; daemon's test count grows by 7.

- [ ] **Step 8: Commit**

```bash
cd /d/Companion && git add packages/daemon/src/rpc-handlers.ts packages/daemon/src/rpc-handlers.test.ts packages/daemon/src/main.ts packages/daemon/README.md
git commit -m "daemon: add list_projects and start_session RPC methods"
```

---

### Task 5: Relay — expose live daemon-connection status

**Closes:** the spec's relay change — `GET /devices/daemon-status` currently only reports pairing (`{paired: boolean}`); Settings needs to know if the paired daemon is actually connected right now, and the relay already tracks this internally.

**Files:**
- Modify: `packages/relay/src/hub.ts` (visibility change only)
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`
- Modify: `packages/web/src/api/devices.ts` (return-type change)
- Modify: `packages/web/src/SessionList.tsx` (one-line consumption fix — see below for why this must land in this task, not a later one)

**Interfaces:**
- Produces: `getDaemonStatus(token): Promise<DaemonStatus>` where `DaemonStatus = { paired: false } | { paired: true; name: string; connected: boolean; pairedAt: number }`. Task 9 (Settings redesign) consumes this shape directly.

**Why `SessionList.tsx` is in this task's file list:** it already calls `getDaemonStatus` and assigns the result straight into a `boolean` state variable (`setDaemonPaired`). Changing `getDaemonStatus`'s return type without touching this call site leaves the web package failing to typecheck the moment this task lands — "every task ends with the full suite green" means this one-line fix travels with the type change, even though `SessionList`'s own UI redesign is Task 8, not this task.

- [ ] **Step 1: Make `isDeviceConnected` public**

In `packages/relay/src/hub.ts`, change:
```typescript
  private isDeviceConnected(deviceId: string): boolean {
```
to:
```typescript
  isDeviceConnected(deviceId: string): boolean {
```
No other change to that method — its logic and doc comment are already correct.

- [ ] **Step 2: Update the existing daemon-status test that this change breaks, and write the two new failing tests**

`packages/relay/src/server.test.ts` already has a `pairDaemon(httpServer, browserToken, deviceName): Promise<string>` helper (returns the daemon's token directly — pairing-code request/claim/poll all happen inside it) and a `describe`-free block of `// --- GET /devices/daemon-status ---` tests. One of the three existing tests there, **`'GET /devices/daemon-status returns paired: true once a daemon is paired to the account'`**, asserts `expect(res.body).toEqual({ paired: true })` — an *exact* match. The moment this task's response gains `name`/`connected`/`pairedAt`, that assertion breaks, since `toEqual` requires the object to have no extra fields. Update it in place rather than leaving it to fail:

```typescript
  it('GET /devices/daemon-status returns paired: true once a daemon is paired to the account', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const browserToken = await registerBrowser(httpServer, 'my-browser');
    await pairDaemon(httpServer, browserToken, 'my-daemon');

    const res = await request(httpServer)
      .get('/devices/daemon-status')
      .set('Authorization', `Bearer ${browserToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paired: true, name: 'my-daemon', connected: false, pairedAt: expect.any(Number) });
  });
```
(`connected: false` here because `pairDaemon` only completes the HTTP pairing handshake — it never opens a WebSocket, so there's genuinely no live connection. That's exactly what the next new test below exercises on purpose, and this updated existing test now covers the disconnected case for free.)

Then add one new test for the connected case, in the same block, following the exact `sockets` array / `waitForOpen` cleanup convention already used throughout this file (search for `waitForOpen` and `sockets.push` to see the pattern in an existing WebSocket-opening test before writing this):

```typescript
  it('GET /devices/daemon-status reports connected: true once the daemon has a live WebSocket connection', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const browserToken = await registerBrowser(httpServer, 'my-browser');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'my-daemon');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);

    const res = await request(httpServer)
      .get('/devices/daemon-status')
      .set('Authorization', `Bearer ${browserToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paired: true, name: 'my-daemon', connected: true, pairedAt: expect.any(Number) });
  });
```

- [ ] **Step 3: Run it, confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/relay packages/relay/src/server.test.ts -t "daemon-status"
```
Expected: FAIL — response body doesn't have `name`/`connected`/`pairedAt` yet.

- [ ] **Step 4: Implement**

In `packages/relay/src/server.ts`, replace the `/devices/daemon-status` handler:

```typescript
  app.get(
    '/devices/daemon-status',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const daemon = await store.getDaemonDeviceForUser(device.userId);
      if (!daemon) {
        res.status(200).json({ paired: false });
        return;
      }
      res.status(200).json({
        paired: true,
        name: daemon.name,
        connected: hub.isDeviceConnected(daemon.id),
        pairedAt: daemon.createdAt,
      });
    })
  );
```

Confirm `hub` is already in scope at this point in `server.ts` (it is — every other route handler in this file already closes over it, e.g. the RPC routes from reliable-transport's Task 6).

- [ ] **Step 5: Run it, confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/relay packages/relay/src/server.test.ts
```
Expected: PASS, including the pre-existing unpaired-case test (`{paired: false}` is unchanged).

- [ ] **Step 6: Update the web client's type and `SessionList.tsx`'s one-line fix**

In `packages/web/src/api/devices.ts`, replace `getDaemonStatus`:

```typescript
export type DaemonStatus =
  | { paired: false }
  | { paired: true; name: string; connected: boolean; pairedAt: number };

export async function getDaemonStatus(token: string): Promise<DaemonStatus> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/daemon-status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch daemon status: HTTP ${res.status}`);
  }
  return (await res.json()) as DaemonStatus;
}
```

In `packages/web/src/SessionList.tsx`, the existing `.then((paired) => { if (!cancelled) setDaemonPaired(paired); })` call site becomes:

```typescript
      .then((status) => {
        if (!cancelled) setDaemonPaired(status.paired);
      })
```

(No other change to this file in this task — its UI redesign is Task 8.)

- [ ] **Step 7: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; relay gains 2 passing tests; web is unaffected in count (existing `SessionList` daemon-status test, if it mocks `getDaemonStatus` returning a bare boolean today, needs updating to return `{paired: true}` / `{paired: false}` instead — check `packages/web/src/SessionList.test.tsx` for any such mock and fix it to match the new return shape before considering this step done).

- [ ] **Step 8: Commit**

```bash
cd /d/Companion && git add packages/relay/src/hub.ts packages/relay/src/server.ts packages/relay/src/server.test.ts packages/web/src/api/devices.ts packages/web/src/SessionList.tsx packages/web/src/SessionList.test.tsx
git commit -m "relay: report live connection state from GET /devices/daemon-status"
```

---

### Task 6: Web — deterministic per-project color

**Closes:** the spec's "each project gets a stable, consistent identity dot" requirement.

**Files:**
- Create: `packages/web/src/project-color.ts`
- Test: `packages/web/src/project-color.test.ts`

**Interfaces:**
- Produces: `colorForProject(path: string): string` (returns a hex color string) — Task 8 (`SessionList` redesign) and Task 7 (`ProjectPicker`, optionally) import this.

**Design note carried from the spec review:** the app's existing Tailwind tokens (`--color-accent`, `--color-warning`, `--color-danger`, `--color-success`, confirmed by reading `packages/web/src/index.css`) are all **semantic** — warning means something needs attention, danger means an error. Reusing them for arbitrary project identity would make a project's dot look like a status indicator by accident. This task defines a small **separate, neutral** palette, local to this one file, not added to `index.css`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/project-color.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { colorForProject, PROJECT_COLOR_PALETTE } from './project-color';

describe('colorForProject', () => {
  it('returns the same color for the same path every time', () => {
    expect(colorForProject('/tmp/my-project')).toBe(colorForProject('/tmp/my-project'));
  });

  it('returns a value from the fixed palette', () => {
    expect(PROJECT_COLOR_PALETTE).toContain(colorForProject('/tmp/my-project'));
  });

  it('spreads across the palette rather than collapsing every path to one color', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/tmp/project-${i}`);
    const colorsUsed = new Set(paths.map(colorForProject));
    expect(colorsUsed.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/project-color.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```typescript
/**
 * A small, neutral color set dedicated to project-identity dots — deliberately separate from the
 * app's semantic Tailwind tokens (--color-accent, --color-warning, --color-danger, --color-success
 * in index.css). Those mean something (attention needed, an error, success); reusing them here
 * would make a project's dot look like a status indicator by accident. Chosen to read clearly
 * against the app's dark canvas (#201a16) and panel (#2d2521) backgrounds.
 */
export const PROJECT_COLOR_PALETTE = ['#5b8ba8', '#8a6fa8', '#5a9e7d', '#c98a4b', '#a85f7a', '#6f9e5e'] as const;

/** A simple, fast, non-cryptographic string hash (djb2) — collision resistance across ~dozens of
 * project paths is more than sufficient here; this is a decorative dot, not a security boundary. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** Deterministic: the same path always maps to the same palette entry, so a project's dot stays
 * consistent across the dashboard without any server-side color assignment or stored state. */
export function colorForProject(path: string): string {
  const index = hashString(path) % PROJECT_COLOR_PALETTE.length;
  return PROJECT_COLOR_PALETTE[index];
}
```

- [ ] **Step 4: Run it, confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/project-color.test.ts
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; web gains 3 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/web/src/project-color.ts packages/web/src/project-color.test.ts
git commit -m "web: add a deterministic, semantically-neutral color per project"
```

---

### Task 7: Web — the start-a-session flow (`StartSessionSheet` + `ProjectPicker`)

**Closes:** the spec's core new user-facing capability.

**Files:**
- Create: `packages/web/src/ProjectPicker.tsx`
- Test: `packages/web/src/ProjectPicker.test.tsx`
- Create: `packages/web/src/StartSessionSheet.tsx`
- Test: `packages/web/src/StartSessionSheet.test.tsx`

**Interfaces:**
- Consumes: `useSessions()` from `SessionsProvider` (already exists) for `callDaemon: (method: string, params?: unknown) => Promise<unknown>`; `RpcError` from `packages/web/src/relay-connection.ts` (already exists, exported) to distinguish typed failures from generic ones; `ProjectListEntry` shape (matches what Task 4's `list_projects` returns — mirror it as a local type here, since the web package doesn't import daemon-internal types across the process boundary, matching how every other cross-process shape in this codebase is duplicated at its boundary rather than imported).
- Produces: `StartSessionSheet` — Task 8 imports and renders it from `SessionList`.

**Context — the pattern to mirror exactly:** read `packages/web/src/PromptInjectionBox.tsx` in full (its "never discard typed input on failure" comment and the `sendState` phase machine are the model for this sheet's prompt step) and `packages/web/src/DaemonOnboarding.tsx` (for this app's existing sheet/panel visual conventions, if that component uses a similar overlay pattern — read it to check before assuming a brand-new pattern is needed).

- [ ] **Step 1: Write the failing `ProjectPicker` test**

Create `packages/web/src/ProjectPicker.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectPicker, { type ProjectListEntry } from './ProjectPicker';

const projects: ProjectListEntry[] = [
  { path: '/home/me/companion', displayName: 'companion', source: 'history', lastUsedAt: 2000 },
  { path: '/home/me/old-project', displayName: 'old-project', source: 'history', lastUsedAt: 1000 },
  { path: '/home/me/root/fresh-clone', displayName: 'fresh-clone', source: 'configured', lastUsedAt: undefined },
];

describe('ProjectPicker', () => {
  it('renders every project, most-recently-used first, as already sorted by the caller', () => {
    render(<ProjectPicker projects={projects} onSelect={vi.fn()} />);
    const items = screen.getAllByRole('button', { name: /companion|old-project|fresh-clone/ });
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining('companion'),
      expect.stringContaining('old-project'),
      expect.stringContaining('fresh-clone'),
    ]);
  });

  it('shows a "first time" badge only on configured-source entries with no history', () => {
    render(<ProjectPicker projects={projects} onSelect={vi.fn()} />);
    const freshRow = screen.getByRole('button', { name: /fresh-clone/ });
    expect(freshRow).toHaveTextContent(/first time/i);
    const knownRow = screen.getByRole('button', { name: /^companion/ });
    expect(knownRow).not.toHaveTextContent(/first time/i);
  });

  it('filters as you type, matching displayName case-insensitively', async () => {
    render(<ProjectPicker projects={projects} onSelect={vi.fn()} />);
    await userEvent.type(screen.getByRole('searchbox'), 'FRESH');
    expect(screen.queryByRole('button', { name: /^companion/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fresh-clone/ })).toBeInTheDocument();
  });

  it('calls onSelect with the chosen project when tapped', async () => {
    const onSelect = vi.fn();
    render(<ProjectPicker projects={projects} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /^companion/ }));
    expect(onSelect).toHaveBeenCalledWith(projects[0]);
  });

  it('shows an empty state when there are no projects at all', () => {
    render(<ProjectPicker projects={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/ProjectPicker.test.tsx
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `ProjectPicker.tsx`**

```tsx
import { useState } from 'react';

export interface ProjectListEntry {
  path: string;
  displayName: string;
  source: 'history' | 'configured';
  lastUsedAt: number | undefined;
}

export interface ProjectPickerProps {
  /** Already sorted by the caller (most-recently-used history first, then configured
   * alphabetically) — mirrors exactly what the daemon's list_projects RPC returns, so this
   * component does no re-sorting of its own. */
  projects: ProjectListEntry[];
  onSelect: (project: ProjectListEntry) => void;
}

export default function ProjectPicker({ projects, onSelect }: ProjectPickerProps) {
  const [query, setQuery] = useState('');
  const filtered = projects.filter((p) => p.displayName.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="space-y-3">
      <input
        type="search"
        role="searchbox"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search projects…"
        aria-label="Search projects"
        className="w-full rounded-md bg-panel px-3 py-2"
      />
      {projects.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No projects yet — configure a projects folder on your computer, or start one locally to get going.
        </p>
      ) : (
        <ul className="space-y-1 max-h-80 overflow-y-auto">
          {filtered.map((project) => (
            <li key={project.path}>
              <button
                type="button"
                onClick={() => onSelect(project)}
                className="w-full text-left rounded-md bg-panel hover:bg-border px-3 py-2"
              >
                <span className="font-medium">{project.displayName}</span>
                {project.source === 'configured' && project.lastUsedAt === undefined && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-border text-ink-muted">First time</span>
                )}
                <p className="text-xs text-ink-faint truncate">{project.path}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Confirm the `ProjectPicker` test passes**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/ProjectPicker.test.tsx
```
Expected: PASS, all 5 tests.

- [ ] **Step 5: Write the failing `StartSessionSheet` test**

Create `packages/web/src/StartSessionSheet.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import StartSessionSheet from './StartSessionSheet';
import * as sessionsProviderModule from './SessionsProvider';
import { RpcError } from './relay-connection';
import { RPC_ERROR_CODES } from '@companion/protocol';

function mockCallDaemon(impl: (method: string, params?: unknown) => Promise<unknown>) {
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [],
    loaded: true,
    connectionState: 'live',
    loadError: undefined,
    dismissSession: vi.fn(),
    sendCommand: vi.fn(),
    callDaemon: impl,
    subscribe: vi.fn(() => () => {}),
  });
}

const oneProject = [{ path: '/home/me/companion', displayName: 'companion', source: 'history' as const, lastUsedAt: 1000 }];

function renderSheet(onStarted = vi.fn(), onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <StartSessionSheet onStarted={onStarted} onClose={onClose} />
    </MemoryRouter>
  );
}

describe('StartSessionSheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads and shows the project list from list_projects', async () => {
    mockCallDaemon(async (method) => (method === 'list_projects' ? oneProject : undefined));
    renderSheet();
    expect(await screen.findByRole('button', { name: /companion/ })).toBeInTheDocument();
  });

  it('after picking a project, shows a prompt input; submitting calls start_session and onStarted with the new id', async () => {
    const onStarted = vi.fn();
    mockCallDaemon(async (method, params) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'start_session') {
        expect(params).toEqual({ projectPath: '/home/me/companion', prompt: 'do the thing' });
        return { id: 'new-session-1', status: 'running' };
      }
      throw new Error('unexpected method');
    });
    renderSheet(onStarted);

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /what should claude do/i }), 'do the thing');
    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('new-session-1'));
  });

  it('preserves the typed prompt and shows the typed error message when start_session fails', async () => {
    mockCallDaemon(async (method) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'start_session') {
        throw new RpcError(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT, "You've reached the limit of concurrent sessions. Stop one before starting another.");
      }
      throw new Error('unexpected method');
    });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));
    const promptBox = screen.getByRole('textbox', { name: /what should claude do/i });
    await userEvent.type(promptBox, 'do the thing');
    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/limit of concurrent sessions/i);
    expect(promptBox).toHaveValue('do the thing');
  });
});
```

- [ ] **Step 6: Confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/StartSessionSheet.test.tsx
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Implement `StartSessionSheet.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSessions } from './SessionsProvider';
import { RpcError } from './relay-connection';
import ProjectPicker, { type ProjectListEntry } from './ProjectPicker';

export interface StartSessionSheetProps {
  onStarted: (sessionId: string) => void;
  onClose: () => void;
}

type Phase =
  | { step: 'loading-projects' }
  | { step: 'picking'; projects: ProjectListEntry[] }
  | { step: 'prompting'; project: ProjectListEntry }
  | { step: 'starting'; project: ProjectListEntry; prompt: string }
  | { step: 'error'; project: ProjectListEntry; prompt: string; message: string };

const DEFAULT_ERROR_MESSAGE = 'Something went wrong starting the session. Try again.';

export default function StartSessionSheet({ onStarted, onClose }: StartSessionSheetProps) {
  const { callDaemon } = useSessions();
  const [phase, setPhase] = useState<Phase>({ step: 'loading-projects' });

  useEffect(() => {
    let cancelled = false;
    callDaemon('list_projects')
      .then((result) => {
        if (!cancelled) setPhase({ step: 'picking', projects: result as ProjectListEntry[] });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof RpcError ? err.message : DEFAULT_ERROR_MESSAGE;
        // Reuses the 'error' phase shape with an empty project/prompt — the picker step has
        // nothing typed yet to preserve, so this is simpler than a fifth phase variant.
        setPhase({ step: 'error', project: { path: '', displayName: '', source: 'history', lastUsedAt: undefined }, prompt: '', message });
      });
    return () => {
      cancelled = true;
    };
  }, [callDaemon]);

  function handleSelect(project: ProjectListEntry) {
    setPhase({ step: 'prompting', project });
  }

  function submit(project: ProjectListEntry, prompt: string) {
    setPhase({ step: 'starting', project, prompt });
    callDaemon('start_session', { projectPath: project.path, prompt })
      .then((result) => {
        const { id } = result as { id: string; status: string };
        onStarted(id);
      })
      .catch((err) => {
        const message = err instanceof RpcError ? err.message : DEFAULT_ERROR_MESSAGE;
        setPhase({ step: 'error', project, prompt, message });
      });
  }

  return (
    <div role="dialog" aria-label="Start a session" className="fixed inset-0 z-10 flex items-end justify-center bg-black/40">
      <div className="w-full max-w-lg bg-canvas rounded-t-xl p-4 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Start a session</h2>
          <button type="button" onClick={onClose} className="text-sm text-ink-muted underline">
            Cancel
          </button>
        </div>

        {phase.step === 'loading-projects' && <p className="text-ink-muted">Loading projects…</p>}

        {phase.step === 'picking' && <ProjectPicker projects={phase.projects} onSelect={handleSelect} />}

        {(phase.step === 'prompting' || phase.step === 'starting' || (phase.step === 'error' && phase.project.path)) && (
          <PromptStep
            project={phase.step === 'error' ? phase.project : phase.step === 'prompting' ? phase.project : phase.project}
            initialPrompt={phase.step === 'error' || phase.step === 'starting' ? phase.prompt : ''}
            pending={phase.step === 'starting'}
            errorMessage={phase.step === 'error' ? phase.message : undefined}
            onSubmit={(prompt) => submit(phase.step === 'error' || phase.step === 'starting' ? phase.project : (phase as Extract<Phase, { step: 'prompting' }>).project, prompt)}
          />
        )}

        {phase.step === 'error' && !phase.project.path && (
          <p role="alert" className="text-sm text-danger-light">
            {phase.message}
          </p>
        )}
      </div>
    </div>
  );
}

function PromptStep({
  project,
  initialPrompt,
  pending,
  errorMessage,
  onSubmit,
}: {
  project: ProjectListEntry;
  initialPrompt: string;
  pending: boolean;
  errorMessage: string | undefined;
  onSubmit: (prompt: string) => void;
}) {
  const [text, setText] = useState(initialPrompt);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || pending) return;
        onSubmit(text);
      }}
      className="space-y-2"
    >
      <p className="text-sm text-ink-muted">{project.displayName}</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should Claude do?"
        aria-label="What should Claude do?"
        rows={3}
        className="w-full rounded-md bg-panel px-3 py-2"
      />
      <button
        type="submit"
        disabled={pending || text.trim().length === 0}
        className="w-full rounded-md bg-accent hover:bg-accent-hover px-3 py-2 font-medium disabled:opacity-50"
      >
        {pending ? 'Starting…' : 'Start'}
      </button>
      {errorMessage && (
        <p role="alert" className="text-sm text-danger-light">
          {errorMessage}
        </p>
      )}
    </form>
  );
}
```

Note: the phase-union plumbing above prioritizes correctness of the "never discard typed input" requirement over elegance. Before moving on, re-read it once as a hostile reviewer: confirm that the `project`/`prompt` carried on the `'error'` phase are exactly what was submitted (not stale), and that switching back from `'error'` to a fresh submit reuses `PromptStep`'s own `text` state (initialized from `initialPrompt`) rather than losing what the user has since edited. If anything reads ambiguous, simplify the phase type rather than leave it as written — this is exactly the kind of code a task reviewer will scrutinize hardest.

- [ ] **Step 8: Confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/StartSessionSheet.test.tsx
```
Expected: PASS, all 3 tests.

- [ ] **Step 9: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; web gains 8 passing tests (5 + 3).

- [ ] **Step 10: Commit**

```bash
cd /d/Companion && git add packages/web/src/ProjectPicker.tsx packages/web/src/ProjectPicker.test.tsx packages/web/src/StartSessionSheet.tsx packages/web/src/StartSessionSheet.test.tsx
git commit -m "web: add the start-a-session project picker and prompt sheet"
```

---

### Task 8: Web — `SessionList` redesign (tiers, project identity, floating start action)

**Closes:** the spec's dashboard redesign — the part of the "feels better than the laptop" bar that applies to the session list.

**Files:**
- Modify: `packages/web/src/SessionList.tsx`
- Modify: `packages/web/src/SessionList.test.tsx`

**Interfaces:**
- Consumes: `colorForProject` (Task 6), `StartSessionSheet` (Task 7), `sortSessions` (existing, unchanged — its priority ordering is already correct; this task changes rendering, not sorting).

**Context:** read the current `packages/web/src/SessionList.tsx` (135 lines, already read in full during plan research) and `packages/web/src/SessionList.test.tsx` before starting.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/SessionList.test.tsx` (read the existing file first to match its mocking helpers for `useSessions`):

```tsx
it('groups sessions into Needs you / Running / Stopped tiers', () => {
  mockSessions({
    sessions: [
      { id: 'a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 },
      { id: 'b', projectPath: '/tmp/b', status: 'waiting_permission', lastEventAt: 2 },
      { id: 'c', projectPath: '/tmp/c', status: 'stopped', lastEventAt: 3 },
    ],
  });
  render(<SessionList token="tok-1" onUnauthorized={vi.fn()} />, { wrapper: MemoryRouterWrapper });

  expect(screen.getByRole('heading', { name: /needs you/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^running$/i })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /stopped/i })).toBeInTheDocument();
});

it('leads each card with the project display name, not the full path', () => {
  mockSessions({
    sessions: [{ id: 'a', projectPath: '/home/me/my-project', status: 'running', lastEventAt: 1 }],
  });
  render(<SessionList token="tok-1" onUnauthorized={vi.fn()} />, { wrapper: MemoryRouterWrapper });

  expect(screen.getByText('my-project')).toBeInTheDocument();
  expect(screen.getByText('/home/me/my-project')).toBeInTheDocument();
});

it('a floating action button opens the start-session sheet', async () => {
  mockSessions({ sessions: [] });
  render(<SessionList token="tok-1" onUnauthorized={vi.fn()} />, { wrapper: MemoryRouterWrapper });

  await userEvent.click(screen.getByRole('button', { name: /start a session/i }));
  expect(screen.getByRole('dialog', { name: /start a session/i })).toBeInTheDocument();
});
```

Adjust `mockSessions`'s shape and the router-wrapper helper to whatever this test file already establishes — do not introduce a second, differently-shaped mock helper alongside an existing one.

- [ ] **Step 2: Confirm it fails**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/SessionList.test.tsx
```
Expected: FAIL — no tier headings, no display-name split, no FAB exist yet.

- [ ] **Step 3: Implement**

Replace `packages/web/src/SessionList.tsx`'s render body (keep every hook, the `showsEmptyState`/`daemonPaired` logic, and `handleDismiss` exactly as they are — only the JSX returned changes):

```tsx
import { colorForProject } from './project-color';
import StartSessionSheet from './StartSessionSheet';

// ... (existing imports, existing hooks/state/effects/handleDismiss unchanged) ...

export default function SessionList({ token, onUnauthorized }: SessionListProps) {
  // ... existing hooks unchanged through `handleDismiss` ...
  const [showStartSheet, setShowStartSheet] = useState(false);
  const navigate = useNavigate();

  if (!loaded) {
    return <p className="text-ink-muted p-4">Loading…</p>;
  }

  const needsYou = sorted.filter((s) => s.status === 'waiting_permission' || s.status === 'waiting_input');
  const running = sorted.filter((s) => s.status === 'running');
  const stopped = sorted.filter((s) => s.status === 'stopped');

  function renderCard(session: SessionSummary) {
    const displayName = session.projectPath.split(/[/\\]/).filter(Boolean).pop() ?? session.projectPath;
    return (
      <li key={session.id} className="bg-panel rounded-md p-4">
        <Link to={`/sessions/${session.id}`} className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1.5 h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: colorForProject(session.projectPath) }}
            />
            <div>
              <p className="font-medium">
                {displayName}
                {session.status === 'waiting_permission' && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warning">Needs attention</span>
                )}
                {session.status === 'waiting_input' && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-accent">Your turn</span>
                )}
              </p>
              <p className="text-sm text-ink-muted">{session.projectPath}</p>
            </div>
          </div>
          <span className="text-xs text-ink-faint">{formatRelativeTime(session.lastEventAt)}</span>
        </Link>
        {session.status === 'stopped' && (
          <div className="mt-2">
            <button type="button" onClick={() => handleDismiss(session.id)} className="text-xs px-3 py-1 rounded-md bg-border">
              Dismiss
            </button>
            {dismissErrors[session.id] && (
              <p role="alert" className="text-xs text-danger-light mt-1">
                {dismissErrors[session.id]}
              </p>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          <ConnectionBadge connectionState={connectionState} />
          <Link to="/settings" className="text-xs text-ink-muted underline">
            Settings
          </Link>
        </div>
      </div>

      {loadError && connectionState !== 'offline' && (
        <p role="alert" className="bg-danger-bg text-danger-text rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      {showsEmptyState &&
        (daemonPaired === false ? (
          <DaemonOnboarding token={token} onUnauthorized={onUnauthorized} />
        ) : daemonPaired === true ? (
          <p className="text-ink-muted">No active sessions.</p>
        ) : null)}

      {needsYou.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-ink-muted mb-2">Needs you</h2>
          <ul className="space-y-2">{needsYou.map(renderCard)}</ul>
        </section>
      )}

      {running.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-ink-muted mb-2">Running</h2>
          <ul className="space-y-2">{running.map(renderCard)}</ul>
        </section>
      )}

      {stopped.length > 0 && (
        <details>
          <summary className="text-sm font-semibold text-ink-muted mb-2 cursor-pointer">
            Stopped ({stopped.length})
          </summary>
          <ul className="space-y-2">{stopped.map(renderCard)}</ul>
        </details>
      )}

      <button
        type="button"
        onClick={() => setShowStartSheet(true)}
        aria-label="Start a session"
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full bg-accent hover:bg-accent-hover text-2xl font-medium shadow-lg flex items-center justify-center"
      >
        +
      </button>

      {showStartSheet && (
        <StartSessionSheet
          onStarted={(sessionId) => {
            setShowStartSheet(false);
            navigate(`/sessions/${sessionId}`);
          }}
          onClose={() => setShowStartSheet(false)}
        />
      )}
    </div>
  );
}
```

Add `useState` (for `showStartSheet` — `useState`/`useEffect`/`useRef` are already imported) and `useNavigate` to the existing `react-router` import line.

- [ ] **Step 4: Confirm it passes**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/SessionList.test.tsx
```
Expected: PASS — the 3 new tests, plus every pre-existing test in this file still passing (the empty-state, loadError, and dismiss-flow tests didn't change behavior, only where their markup sits).

- [ ] **Step 5: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; web gains 3 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /d/Companion && git add packages/web/src/SessionList.tsx packages/web/src/SessionList.test.tsx
git commit -m "web: redesign the session list into status tiers with project identity and a start action"
```

---

### Task 9: Web — fix `SettingsScreen`'s daemon-status bug with a real status card

**Closes:** the confirmed bug (the "Pair a daemon" form has no conditional at all — always renders) and the spec's daemon-status card design.

**Files:**
- Modify: `packages/web/src/SettingsScreen.tsx`
- Modify: `packages/web/src/SettingsScreen.test.tsx`

**Interfaces:**
- Consumes: `DaemonStatus` and `getDaemonStatus` (Task 5).

**Context — why this task touches nearly every existing test in the file:** `packages/web/src/SettingsScreen.test.tsx` (377 lines, read in full during plan research) has 21 tests. **None of them mock `getDaemonStatus` today** — the pairing form currently renders unconditionally, so every test that reaches it works by accident of the bug. Gating the form behind a real `paired === false` check means every test that currently exercises the pairing form or reaches past it (which is nearly all of them — 18 of the 21) will fail unless a `getDaemonStatus` mock is added. This is mechanical but must be done completely, not partially — a half-updated test file left "mostly green" with a few silently-skipped-in-spirit tests is worse than a clean rewrite of the affected mocks.

- [ ] **Step 1: Add a shared daemon-status mock helper and apply it everywhere the file currently calls `mockDeviceLoad()` or inlines a `getDevice` mock**

At the top of `packages/web/src/SettingsScreen.test.tsx`, add one shared helper (the file currently has `mockDeviceLoad` duplicated inside two `describe` blocks plus inline in top-level tests — consolidate to one, at file scope, used everywhere):

```typescript
function mockDeviceLoad() {
  vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
    id: 'dev-1',
    type: 'browser',
    name: 'Chrome on Mac',
    createdAt: 1,
  });
}

function mockDaemonStatus(status: Awaited<ReturnType<typeof devicesApi.getDaemonStatus>> = { paired: false }) {
  vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(status);
}
```

Remove the two duplicate local `mockDeviceLoad` function declarations inside the `'pair a daemon section'` and `'notifications section'` describe blocks — they become dead code once the shared one at file scope covers every use.

Every test in the file that currently calls `mockDeviceLoad()` (or inlines an equivalent `getDevice` mock) needs `mockDaemonStatus()` added right after it — defaulting to `{ paired: false }` for every test in the `'pair a daemon section'` describe block (so the form still renders exactly as those tests expect) and every test in the `'notifications section'` describe block and the top-level tests (their content doesn't depend on daemon status at all, so `{ paired: false }` is a safe, arbitrary default — the point is only that *something* resolves so the component doesn't hang in a loading state these tests don't test for).

- [ ] **Step 2: Write the new failing tests for the three daemon-status states**

Add a new `describe('daemon status section', ...)` block:

```tsx
describe('daemon status section', () => {
  it('shows the pairing form when no daemon is paired', async () => {
    mockDeviceLoad();
    mockDaemonStatus({ paired: false });

    renderSettings();

    expect(await screen.findByRole('button', { name: /pair daemon/i })).toBeInTheDocument();
  });

  it('shows daemon name and paired-since date, and hides the pairing form, when paired and connected', async () => {
    mockDeviceLoad();
    mockDaemonStatus({ paired: true, name: 'my-laptop', connected: true, pairedAt: new Date('2026-02-01').getTime() });

    renderSettings();

    expect(await screen.findByText('my-laptop')).toBeInTheDocument();
    expect(screen.getByText(/online/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pair daemon$/i })).not.toBeInTheDocument();
  });

  it('shows an offline state, without inventing a last-seen timestamp, when paired but disconnected', async () => {
    mockDeviceLoad();
    mockDaemonStatus({ paired: true, name: 'my-laptop', connected: false, pairedAt: 1 });

    renderSettings();

    expect(await screen.findByText('my-laptop')).toBeInTheDocument();
    expect(screen.getByText(/offline/i)).toBeInTheDocument();
    expect(screen.queryByText(/last seen/i)).not.toBeInTheDocument();
  });

  it('shows a disabled "Unpair daemon" action when paired — no relay endpoint exists yet to wire it to', async () => {
    mockDeviceLoad();
    mockDaemonStatus({ paired: true, name: 'my-laptop', connected: true, pairedAt: 1 });

    renderSettings();

    expect(await screen.findByRole('button', { name: /unpair daemon/i })).toBeDisabled();
  });

  it('a daemon-status load failure fails toward showing the pairing form, not a stuck loading state', async () => {
    mockDeviceLoad();
    vi.spyOn(devicesApi, 'getDaemonStatus').mockRejectedValue(new Error('HTTP 500'));

    renderSettings();

    expect(await screen.findByRole('button', { name: /pair daemon/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Confirm the whole file fails as expected**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/SettingsScreen.test.tsx
```
Expected: the 5 new tests FAIL (no daemon-status card exists yet), and every pre-existing test now also FAILS or hangs on loading, since `getDaemonStatus` is unmocked in the component's real (still-unbuilt) usage — this is expected at this point; Step 5 makes them pass together.

- [ ] **Step 4: Implement the daemon-status card in `SettingsScreen.tsx`**

Add state and an effect (alongside the existing `device`/`loadError` state, following the exact same load pattern used for `getDevice`):

```typescript
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | undefined>();

  useEffect(() => {
    let cancelled = false;
    getDaemonStatus(token)
      .then((status) => {
        if (!cancelled) setDaemonStatus(status);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnpairedRef.current();
          return;
        }
        // Same "fail toward the actionable state" reasoning as SessionList's daemon-status check:
        // a load failure must not leave the user stuck looking at nothing.
        setDaemonStatus({ paired: false });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

**No `handleUnpairDaemon` function is written — confirmed during plan-writing, not left as an implementer's judgment call.** `packages/relay/src/server.ts`'s `POST /devices/unpair` handler (read in full) always calls `store.deleteDevice(device.id)`, where `device` is resolved from the caller's own auth token — there is no target-device parameter. A browser can only ever unpair *itself* through it, never the daemon. Building a real "Unpair daemon" action would mean adding a new relay route, which the approved spec's Settings section does not call for (it describes the card showing "a quiet Unpair action" without specifying new relay surface for it). Implement the button **disabled**, so its presence is honest about what exists today without either skipping it (failing the test below) or quietly inventing untested relay surface outside this plan's scope:

```tsx
          <button
            type="button"
            disabled
            title="Unpairing the daemon isn't available yet"
            className="text-sm text-ink-faint underline decoration-dotted disabled:cursor-not-allowed"
          >
            Unpair daemon
          </button>
```

Replace the render section (the `{device && (...)}` block stays exactly as-is — it is unrelated, separate information about the browser itself; the change is entirely around the pairing-form block):

```tsx
      {device && (
        <div className="bg-panel rounded-md p-4 space-y-1">
          <p className="font-medium">{device.name}</p>
          <p className="text-sm text-ink-muted capitalize">{device.type}</p>
          <p className="text-sm text-ink-muted">Paired {new Date(device.createdAt).toLocaleDateString()}</p>
        </div>
      )}

      {daemonStatus?.paired === true && (
        <div className="border-t border-border pt-4 space-y-3">
          <h2 className="text-sm font-medium text-ink-secondary">Daemon</h2>
          <div className="bg-panel rounded-md p-4 space-y-1">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${daemonStatus.connected ? 'bg-success' : 'bg-warning'}`}
              />
              <p className="font-medium">{daemonStatus.name}</p>
            </div>
            <p className="text-sm text-ink-muted">{daemonStatus.connected ? 'Online' : 'Offline'}</p>
            <p className="text-sm text-ink-muted">Paired {new Date(daemonStatus.pairedAt).toLocaleDateString()}</p>
          </div>
          <button
            type="button"
            onClick={handleUnpairDaemon}
            className="text-sm text-ink-muted underline"
          >
            Unpair daemon
          </button>
        </div>
      )}

      {daemonStatus?.paired === false && (
        <form onSubmit={handleClaimPairingCode} className="border-t border-border pt-4 space-y-3">
          {/* ... existing form contents, byte-for-byte unchanged ... */}
        </form>
      )}
```

Import `DaemonStatus` and `getDaemonStatus` from `./api/devices` in the existing import line.

- [ ] **Step 5: Confirm every test passes**

```bash
cd /d/Companion && npx vitest run -r packages/web packages/web/src/SettingsScreen.test.tsx
```
Expected: PASS — all pre-existing tests (now with the added `mockDaemonStatus({paired: false})` calls) plus the 5 new ones.

- [ ] **Step 6: Full suite check**

```bash
cd /d/Companion && npm run build && npm test
```
Expected: build clean; web's total test count for this file is unchanged in pass/fail ratio (21 existing + 5 new = 26, all passing) other than the net +5.

- [ ] **Step 7: Commit**

```bash
cd /d/Companion && git add packages/web/src/SettingsScreen.tsx packages/web/src/SettingsScreen.test.tsx
git commit -m "web: fix Settings always showing the pairing form; add a real daemon status card"
```

---

## Final whole-branch review

After Task 9, dispatch the final code reviewer (per subagent-driven-development's process) over the full branch diff against `master`. Point it explicitly at:
- The `StartSessionSheet` phase-union logic (Task 7, Step 7's note) — this is the most structurally complex piece in the plan and the one most likely to have a subtle "typed input lost on retry" bug.
- `resolveKnownProjects`'s merge/dedupe logic (Task 4) — verify a path that starts as `'configured'` and then gets a session started in it is reported as `'history'` on the *next* `list_projects` call, not left stale as `'configured'` (the dedup happens by checking `historyPaths.has(fullPath)` against freshly-read history each call, so this should already hold — confirm it, don't assume it).
- Task 9's disabled "Unpair daemon" button — re-confirm `/devices/unpair` still has no target-device parameter in the final tree (a concurrent, unrelated change could in principle have added one, which would make the disabled state stale).
- The claim, repeated throughout this plan, that nothing outside `SessionManager`'s own files referenced `getActiveSession()`/`activeSessionId` — re-verify this against the final tree, not just the pre-Task-3 snapshot this plan was written against.
