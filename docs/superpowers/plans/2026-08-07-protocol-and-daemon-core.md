# Protocol + Daemon Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `@companion/protocol` schema package and the `@companion/daemon` core (`SessionManager`/`SessionRunner` wrapping the Claude Agent SDK), fully testable standalone with a mocked SDK, plus a local-only HTTP control surface to exercise the whole lifecycle end to end without a relay or web app yet.

**Architecture:** The daemon owns Claude Code sessions via the Claude Agent SDK's streaming-input `query()` API. `SessionRunner` wraps one SDK `Query` behind a small, hand-rolled port interface (`agent-sdk-port.ts`) so all core logic can be unit-tested against a mock, with the real SDK wired in behind one adapter at the very end. `SessionManager` owns a `Map<sessionId, SessionRunner>` and enforces one active session in v1. Every event `SessionRunner` produces is a `@companion/protocol` `SessionEvent`, the same schema the relay (Plan 2) and web app (Plan 3) will consume later.

**Tech Stack:** Node.js + TypeScript (NodeNext modules), npm workspaces, Zod (schemas), Vitest (tests), Express + Supertest (local HTTP control surface + its tests), `@anthropic-ai/claude-agent-sdk`.

## Global Constraints

- Node.js + TypeScript across all packages (per spec Tech Stack).
- The wire contract (events + commands) is defined once, in `@companion/protocol`, using Zod schemas — the daemon, relay, and web app all import from it rather than redefining shapes (per spec Architecture section).
- The daemon is outbound-only in production — no inbound ports (per spec Security section). The local HTTP server built in this plan is an explicitly **local-only dev/test control surface**, bound to `localhost`, and is not the daemon's production relay connection (that arrives in a later plan).
- v1 enforces exactly one active session at a time; internally modeled as `Map<sessionId, SessionRunner>` so relaxing that limit later doesn't require a redesign (per spec Data model section).
- A session must never be silently left in a `running` state after the underlying agent crashes — always transition to `stopped` and record an `error` event (per spec Error handling section).

---

## Task 1: Monorepo scaffold

**Files:**
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`, `packages/protocol/src/smoke.test.ts`
- Create: `packages/daemon/package.json`, `packages/daemon/tsconfig.json`, `packages/daemon/src/index.ts`, `packages/daemon/src/smoke.test.ts`
- Create: `.gitignore`

**Interfaces:**
- Produces: an npm-workspaces monorepo where `npm test` (root) runs every package's Vitest suite, and `npm run build` (root) compiles every package. Later tasks add real files into `packages/protocol/src/` and `packages/daemon/src/`.

- [ ] **Step 1: Create the root workspace manifest**

```bash
cd "d:/Companion"
npm init -y
```

Edit the generated `package.json` to:

```json
{
  "name": "claude-companion",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present"
  }
}
```

- [ ] **Step 2: Add the shared TypeScript config**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist"
  }
}
```

- [ ] **Step 3: Scaffold `packages/protocol`**

```bash
mkdir -p "d:/Companion/packages/protocol/src"
cd "d:/Companion/packages/protocol"
npm init -y
npm install zod
npm install -D typescript vitest
```

Edit `packages/protocol/package.json` to:

```json
{
  "name": "@companion/protocol",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

(Leave the exact installed version numbers `npm install` wrote — the block above is the shape to edit into, not literal values to force.)

Create `packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Create `packages/protocol/src/index.ts`:

```ts
export const PROTOCOL_PLACEHOLDER = true;
```

Create `packages/protocol/src/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PROTOCOL_PLACEHOLDER } from './index.js';

describe('protocol package scaffold', () => {
  it('loads', () => {
    expect(PROTOCOL_PLACEHOLDER).toBe(true);
  });
});
```

- [ ] **Step 4: Scaffold `packages/daemon`**

```bash
mkdir -p "d:/Companion/packages/daemon/src"
cd "d:/Companion/packages/daemon"
npm init -y
npm install express @companion/protocol@*
npm install -D typescript vitest supertest @types/express @types/supertest @types/node
```

If `npm install @companion/protocol@*` fails to resolve the workspace package (it should, via npm workspaces, once run from the repo root instead), run the two install commands from `d:/Companion` (repo root) instead of from inside `packages/daemon`, e.g. `npm install express -w @companion/daemon`.

Edit `packages/daemon/package.json` to:

```json
{
  "name": "@companion/daemon",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@companion/protocol": "*",
    "express": "^4.21.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "supertest": "^7.0.0",
    "@types/express": "^4.17.0",
    "@types/supertest": "^6.0.0",
    "@types/node": "^22.0.0"
  }
}
```

Create `packages/daemon/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../protocol" }]
}
```

Create `packages/daemon/src/index.ts`:

```ts
export const DAEMON_PLACEHOLDER = true;
```

Create `packages/daemon/src/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DAEMON_PLACEHOLDER } from './index.js';

describe('daemon package scaffold', () => {
  it('loads', () => {
    expect(DAEMON_PLACEHOLDER).toBe(true);
  });
});
```

- [ ] **Step 5: Add `.gitignore`**

Create `d:/Companion/.gitignore`:

```
node_modules/
dist/
*.log
```

- [ ] **Step 6: Verify the workspace runs**

```bash
cd "d:/Companion"
npm test
```

Expected: both `@companion/protocol` and `@companion/daemon` smoke tests pass (2 test files, 2 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json packages .gitignore
git commit -m "chore: scaffold npm workspaces monorepo (protocol + daemon packages)"
```

---

## Task 2: Protocol schemas — session events and commands

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/src/events.test.ts`
- Create: `packages/protocol/src/commands.ts`
- Create: `packages/protocol/src/commands.test.ts`
- Delete: `packages/protocol/src/smoke.test.ts` (superseded)

**Interfaces:**
- Consumes: nothing (leaf package).
- Produces: `SessionStatus` (`'running' | 'waiting_permission' | 'paused' | 'stopped'`), `SessionEvent` (Zod discriminated union + inferred type), `Command` (Zod discriminated union + inferred type). These are the exact types every later task (`SessionRunner`, `SessionManager`, the HTTP layer) imports from `@companion/protocol`.

- [ ] **Step 1: Write the failing test for `SessionEvent`**

Create `packages/protocol/src/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SessionEvent } from './events.js';

describe('SessionEvent schema', () => {
  it('accepts a valid session_started event', () => {
    const result = SessionEvent.safeParse({
      type: 'session_started',
      sessionId: 'abc',
      projectPath: '/tmp/project',
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid permission_request event', () => {
    const result = SessionEvent.safeParse({
      type: 'permission_request',
      sessionId: 'abc',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      at: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an event with an unknown type', () => {
    const result = SessionEvent.safeParse({
      type: 'not_a_real_event',
      sessionId: 'abc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a permission_request missing requestId', () => {
    const result = SessionEvent.safeParse({
      type: 'permission_request',
      sessionId: 'abc',
      toolName: 'Bash',
      input: {},
      at: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd "d:/Companion/packages/protocol"
npx vitest run src/events.test.ts
```

Expected: FAIL — `./events.js` does not exist.

- [ ] **Step 3: Implement `events.ts`**

Create `packages/protocol/src/events.ts`:

```ts
import { z } from 'zod';

export const SessionStatus = z.enum([
  'running',
  'waiting_permission',
  'paused',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_started'),
    sessionId: z.string(),
    projectPath: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('assistant_text'),
    sessionId: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('tool_use'),
    sessionId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('tool_result'),
    sessionId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('permission_request'),
    sessionId: z.string(),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('permission_resolved'),
    sessionId: z.string(),
    requestId: z.string(),
    approved: z.boolean(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('turn_complete'),
    sessionId: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('error'),
    sessionId: z.string(),
    message: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('stopped'),
    sessionId: z.string(),
    at: z.number(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/events.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for `Command`**

Create `packages/protocol/src/commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Command } from './commands.js';

describe('Command schema', () => {
  it('accepts a valid start_session command', () => {
    const result = Command.safeParse({
      type: 'start_session',
      projectPath: '/tmp/project',
      prompt: 'do the thing',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid respond_to_permission command', () => {
    const result = Command.safeParse({
      type: 'respond_to_permission',
      sessionId: 'abc',
      requestId: 'req-1',
      approved: false,
      reason: 'too risky',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a stop command missing sessionId', () => {
    const result = Command.safeParse({ type: 'stop' });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run src/commands.test.ts
```

Expected: FAIL — `./commands.js` does not exist.

- [ ] **Step 7: Implement `commands.ts`**

Create `packages/protocol/src/commands.ts`:

```ts
import { z } from 'zod';

export const StartSessionCommand = z.object({
  type: z.literal('start_session'),
  projectPath: z.string(),
  prompt: z.string(),
});

export const InjectPromptCommand = z.object({
  type: z.literal('inject_prompt'),
  sessionId: z.string(),
  text: z.string(),
});

export const RespondToPermissionCommand = z.object({
  type: z.literal('respond_to_permission'),
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});

export const PauseCommand = z.object({
  type: z.literal('pause'),
  sessionId: z.string(),
});

export const ResumeCommand = z.object({
  type: z.literal('resume'),
  sessionId: z.string(),
});

export const StopCommand = z.object({
  type: z.literal('stop'),
  sessionId: z.string(),
});

export const Command = z.discriminatedUnion('type', [
  StartSessionCommand,
  InjectPromptCommand,
  RespondToPermissionCommand,
  PauseCommand,
  ResumeCommand,
  StopCommand,
]);
export type Command = z.infer<typeof Command>;
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run src/commands.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 9: Wire up the package entrypoint and remove the scaffold placeholder**

Replace `packages/protocol/src/index.ts` with:

```ts
export * from './events.js';
export * from './commands.js';
```

Delete `packages/protocol/src/smoke.test.ts`.

- [ ] **Step 10: Run the full protocol suite**

```bash
npx vitest run
```

Expected: PASS (7 tests: 4 events + 3 commands).

- [ ] **Step 11: Commit**

```bash
cd "d:/Companion"
git add packages/protocol
git commit -m "feat(protocol): add SessionEvent and Command Zod schemas"
```

---

## Task 3: Daemon — `AsyncQueue` utility

**Files:**
- Create: `packages/daemon/src/async-queue.ts`
- Create: `packages/daemon/src/async-queue.test.ts`
- Delete: `packages/daemon/src/smoke.test.ts` (superseded)

**Interfaces:**
- Consumes: nothing.
- Produces: `class AsyncQueue<T> implements AsyncIterable<T>` with `push(value: T): void` and `close(): void`. `SessionRunner` (Task 4) uses this as the controllable input stream it hands to the Agent SDK's `query()`.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/async-queue.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AsyncQueue } from './async-queue.js';

describe('AsyncQueue', () => {
  it('yields pushed values in order when closed after pushing', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const received: number[] = [];
    for await (const v of q) {
      received.push(v);
    }
    expect(received).toEqual([1, 2]);
  });

  it('resolves a pending consumer when a value is pushed later', async () => {
    const q = new AsyncQueue<string>();
    const iterator = q[Symbol.asyncIterator]();
    const pending = iterator.next();

    q.push('hello');

    const result = await pending;
    expect(result).toEqual({ value: 'hello', done: false });
  });

  it('throws if pushed to after close', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "d:/Companion/packages/daemon"
npx vitest run src/async-queue.test.ts
```

Expected: FAIL — `./async-queue.js` does not exist.

- [ ] **Step 3: Implement `AsyncQueue`**

Create `packages/daemon/src/async-queue.ts`:

```ts
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      throw new Error('Cannot push to a closed AsyncQueue');
    }
    const resolve = this.resolvers.shift();
    if (resolve) {
      resolve({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/async-queue.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Remove the scaffold placeholder**

Delete `packages/daemon/src/smoke.test.ts`. Leave `packages/daemon/src/index.ts` as-is for now — Task 8 replaces it.

- [ ] **Step 6: Commit**

```bash
cd "d:/Companion"
git add packages/daemon
git commit -m "feat(daemon): add AsyncQueue controllable async iterable"
```

---

## Task 4: Daemon — Agent SDK port interface

**Files:**
- Create: `packages/daemon/src/agent-sdk-port.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentMessage`, `PermissionRequest`, `PermissionResponse`, `AgentQuery`, `AgentQueryOptions`, `QueryFn` — the seam between our code and the real Agent SDK. `SessionRunner` (Task 5) is written entirely against these types; Task 8 provides the one adapter that implements `QueryFn` using the real `@anthropic-ai/claude-agent-sdk` package.

This task has no independent test — it's a type-only file. It's verified by the type-checker when Task 5's tests compile against it.

- [ ] **Step 1: Create the port interface**

Create `packages/daemon/src/agent-sdk-port.ts`:

```ts
export interface AgentMessage {
  type: string;
  [key: string]: unknown;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface PermissionResponse {
  approved: boolean;
  reason?: string;
}

export interface AgentQuery extends AsyncIterable<AgentMessage> {
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentQueryOptions {
  cwd: string;
  canUseTool: (request: PermissionRequest) => Promise<PermissionResponse>;
}

export type QueryFn = (args: {
  prompt: AsyncIterable<{ type: 'user'; text: string }>;
  options: AgentQueryOptions;
}) => AgentQuery;
```

- [ ] **Step 2: Verify the package still compiles**

```bash
cd "d:/Companion/packages/daemon"
npx tsc -p tsconfig.json --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "d:/Companion"
git add packages/daemon/src/agent-sdk-port.ts
git commit -m "feat(daemon): add Agent SDK port interface"
```

---

## Task 5: Daemon — `SessionRunner` core lifecycle

**Files:**
- Create: `packages/daemon/src/session-runner.ts`
- Create: `packages/daemon/src/session-runner.test.ts`

**Interfaces:**
- Consumes: `AsyncQueue` (Task 3); `AgentMessage`, `AgentQuery`, `AgentQueryOptions`, `PermissionRequest`, `PermissionResponse`, `QueryFn` (Task 4); `SessionEvent`, `SessionStatus` (Task 2, via `@companion/protocol`).
- Produces: `class SessionRunner` with constructor `{ id: string; projectPath: string; queryFn: QueryFn; onEvent: (event: SessionEvent) => void }`, readonly `id: string`, getter `status: SessionStatus`, and methods `start(initialPrompt: string): void`, `injectPrompt(text: string): void`, `respondToPermission(requestId: string, response: PermissionResponse): void`, `pause(): Promise<void>`, `resume(): void`, `stop(): Promise<void>`. `SessionManager` (Task 6) and the HTTP layer (Task 7) are written against exactly this surface.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/session-runner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionRunner } from './session-runner.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

function createMockAgent() {
  const outgoing = new AsyncQueue<AgentMessage>();
  const interrupt = vi.fn(async () => {});
  const close = vi.fn(() => outgoing.close());
  let capturedCanUseTool:
    | ((request: PermissionRequest) => Promise<PermissionResponse>)
    | undefined;
  let capturedPrompt: AsyncIterable<{ type: 'user'; text: string }> | undefined;

  const queryFn: QueryFn = ({ prompt, options }) => {
    capturedPrompt = prompt;
    capturedCanUseTool = options.canUseTool;
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt,
      close,
    };
    return agentQuery;
  };

  return {
    queryFn,
    outgoing,
    interrupt,
    close,
    getCanUseTool: () => capturedCanUseTool!,
    getPrompt: () => capturedPrompt!,
  };
}

describe('SessionRunner', () => {
  it('emits session_started and assistant_text events as the agent streams messages', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    agent.outgoing.push({ type: 'assistant_text', text: 'Working on it' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: 'session-1' });
    expect(events[1]).toMatchObject({ type: 'assistant_text', text: 'Working on it' });
  });

  it('emits a permission_request and blocks until respondToPermission resolves it', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-2',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the risky thing');
    await new Promise((resolve) => setImmediate(resolve));

    const canUseTool = agent.getCanUseTool();
    let responded = false;
    const responsePromise = canUseTool({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    }).then((r) => {
      responded = true;
      return r;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.status).toBe('waiting_permission');
    expect(events.some((e) => e.type === 'permission_request')).toBe(true);
    expect(responded).toBe(false);

    runner.respondToPermission('req-1', { approved: true });
    const response = await responsePromise;

    expect(response).toEqual({ approved: true });
    expect(runner.status).toBe('running');
    expect(events.some((e) => e.type === 'permission_resolved')).toBe(true);
  });

  it('pause calls interrupt on the underlying agent query and sets status paused', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-3',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.pause();

    expect(agent.interrupt).toHaveBeenCalledTimes(1);
    expect(runner.status).toBe('paused');
  });

  it('resume sets status back to running, and injectPrompt pushes onto the input stream', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-4',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.pause();
    runner.resume();
    expect(runner.status).toBe('running');

    runner.injectPrompt('follow up prompt');
    const prompt = agent.getPrompt();
    const iterator = prompt[Symbol.asyncIterator]();
    await iterator.next(); // consumes 'do the thing'
    const second = await iterator.next();
    expect(second.value).toEqual({ type: 'user', text: 'follow up prompt' });
  });

  it('stop closes the input queue and the agent query, and emits a stopped event', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-5',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await runner.stop();

    expect(agent.close).toHaveBeenCalledTimes(1);
    expect(runner.status).toBe('stopped');
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
  });

  it('emits an error event and marks the session stopped if the agent stream throws', async () => {
    const queryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crashed')),
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-6',
      projectPath: '/tmp/project',
      queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      events.some((e) => e.type === 'error' && e.message === 'agent crashed')
    ).toBe(true);
    expect(runner.status).toBe('stopped');
  });

  it('rejects injecting a prompt into a stopped session', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-7',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.stop();

    expect(() => runner.injectPrompt('too late')).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "d:/Companion/packages/daemon"
npx vitest run src/session-runner.test.ts
```

Expected: FAIL — `./session-runner.js` does not exist.

- [ ] **Step 3: Implement `SessionRunner`**

Create `packages/daemon/src/session-runner.ts`:

```ts
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import type { SessionEvent, SessionStatus } from '@companion/protocol';

export interface SessionRunnerOptions {
  id: string;
  projectPath: string;
  queryFn: QueryFn;
  onEvent: (event: SessionEvent) => void;
}

export class SessionRunner {
  readonly id: string;
  private readonly projectPath: string;
  private readonly queryFn: QueryFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private inputQueue = new AsyncQueue<{ type: 'user'; text: string }>();
  private agentQuery: AgentQuery | undefined;
  private _status: SessionStatus = 'running';
  private pendingPermissions = new Map<string, (response: PermissionResponse) => void>();

  constructor(options: SessionRunnerOptions) {
    this.id = options.id;
    this.projectPath = options.projectPath;
    this.queryFn = options.queryFn;
    this.onEvent = options.onEvent;
  }

  get status(): SessionStatus {
    return this._status;
  }

  start(initialPrompt: string): void {
    this.agentQuery = this.queryFn({
      prompt: this.inputQueue,
      options: {
        cwd: this.projectPath,
        canUseTool: (request) => this.handlePermissionRequest(request),
      },
    });
    this.inputQueue.push({ type: 'user', text: initialPrompt });
    this.emit({
      type: 'session_started',
      sessionId: this.id,
      projectPath: this.projectPath,
      at: Date.now(),
    });
    void this.drainMessages();
  }

  injectPrompt(text: string): void {
    if (this._status === 'stopped') {
      throw new Error(`Cannot inject a prompt into stopped session ${this.id}`);
    }
    if (this._status === 'waiting_permission') {
      throw new Error(
        `Cannot inject a prompt into session ${this.id} while a permission request is pending`
      );
    }
    this._status = 'running';
    this.inputQueue.push({ type: 'user', text });
  }

  respondToPermission(requestId: string, response: PermissionResponse): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) {
      throw new Error(`No pending permission request ${requestId} on session ${this.id}`);
    }
    this.pendingPermissions.delete(requestId);
    resolve(response);
    this.emit({
      type: 'permission_resolved',
      sessionId: this.id,
      requestId,
      approved: response.approved,
      at: Date.now(),
    });
    if (this.pendingPermissions.size === 0) {
      this._status = 'running';
    }
  }

  async pause(): Promise<void> {
    if (!this.agentQuery) throw new Error(`Session ${this.id} has not started`);
    await this.agentQuery.interrupt();
    this._status = 'paused';
  }

  resume(): void {
    if (this._status !== 'paused') {
      throw new Error(`Cannot resume session ${this.id} from status ${this._status}`);
    }
    this._status = 'running';
  }

  async stop(): Promise<void> {
    if (!this.agentQuery) throw new Error(`Session ${this.id} has not started`);
    this.inputQueue.close();
    this.agentQuery.close();
    this._status = 'stopped';
    this.emit({ type: 'stopped', sessionId: this.id, at: Date.now() });
  }

  private handlePermissionRequest(request: PermissionRequest): Promise<PermissionResponse> {
    this._status = 'waiting_permission';
    this.emit({
      type: 'permission_request',
      sessionId: this.id,
      requestId: request.requestId,
      toolName: request.toolName,
      input: request.input,
      at: Date.now(),
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(request.requestId, resolve);
    });
  }

  private async drainMessages(): Promise<void> {
    if (!this.agentQuery) return;
    try {
      for await (const message of this.agentQuery) {
        this.handleMessage(message);
      }
    } catch (err) {
      this.emit({
        type: 'error',
        sessionId: this.id,
        message: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
      this._status = 'stopped';
    }
  }

  private handleMessage(message: AgentMessage): void {
    switch (message.type) {
      case 'assistant_text':
        this.emit({
          type: 'assistant_text',
          sessionId: this.id,
          text: String(message.text ?? ''),
          at: Date.now(),
        });
        break;
      case 'tool_use':
        this.emit({
          type: 'tool_use',
          sessionId: this.id,
          toolName: String(message.toolName ?? ''),
          input: message.input,
          at: Date.now(),
        });
        break;
      case 'tool_result':
        this.emit({
          type: 'tool_result',
          sessionId: this.id,
          toolName: String(message.toolName ?? ''),
          isError: Boolean(message.isError),
          at: Date.now(),
        });
        break;
      case 'turn_complete':
        this.emit({ type: 'turn_complete', sessionId: this.id, at: Date.now() });
        break;
      default:
        break;
    }
  }

  private emit(event: SessionEvent): void {
    this.onEvent(event);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/session-runner.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd "d:/Companion"
git add packages/daemon/src/session-runner.ts packages/daemon/src/session-runner.test.ts
git commit -m "feat(daemon): add SessionRunner wrapping the Agent SDK port"
```

---

## Task 6: Daemon — `SessionManager` (single active session)

**Files:**
- Create: `packages/daemon/src/session-manager.ts`
- Create: `packages/daemon/src/session-manager.test.ts`

**Interfaces:**
- Consumes: `SessionRunner`, `SessionRunnerOptions` (Task 5); `QueryFn` (Task 4); `SessionEvent` (Task 2).
- Produces: `class SessionManager` with constructor `{ queryFn: QueryFn; onEvent: (event: SessionEvent) => void }` and methods `startSession(projectPath: string, prompt: string): SessionRunner`, `getSession(id: string): SessionRunner`, `getActiveSession(): SessionRunner | undefined`, `stopSession(id: string): Promise<void>`. The HTTP layer (Task 7) is written against exactly this surface.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/session-manager.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

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

describe('SessionManager', () => {
  it('starts a session and makes it the active session', () => {
    const events: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: createMockQueryFn(),
      onEvent: (e) => events.push(e),
    });

    const runner = manager.startSession('/tmp/project', 'do the thing');

    expect(manager.getActiveSession()?.id).toBe(runner.id);
    expect(manager.getSession(runner.id)).toBe(runner);
  });

  it('throws when starting a second session while one is active', () => {
    const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {} });

    manager.startSession('/tmp/project', 'first');

    expect(() => manager.startSession('/tmp/project', 'second')).toThrow();
  });

  it('throws when looking up an unknown session id', () => {
    const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {} });
    expect(() => manager.getSession('does-not-exist')).toThrow();
  });

  it('clears the active slot after stopSession, allowing a new session to start', async () => {
    const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {} });

    const first = manager.startSession('/tmp/project', 'first');
    await manager.stopSession(first.id);

    expect(manager.getActiveSession()).toBeUndefined();

    const second = manager.startSession('/tmp/project', 'second');
    expect(manager.getActiveSession()?.id).toBe(second.id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "d:/Companion/packages/daemon"
npx vitest run src/session-manager.test.ts
```

Expected: FAIL — `./session-manager.js` does not exist.

- [ ] **Step 3: Implement `SessionManager`**

Create `packages/daemon/src/session-manager.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { SessionRunner } from './session-runner.js';
import type { QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

export interface SessionManagerOptions {
  queryFn: QueryFn;
  onEvent: (event: SessionEvent) => void;
}

export class SessionManager {
  private readonly queryFn: QueryFn;
  private readonly onEvent: (event: SessionEvent) => void;
  private sessions = new Map<string, SessionRunner>();
  private activeSessionId: string | undefined;

  constructor(options: SessionManagerOptions) {
    this.queryFn = options.queryFn;
    this.onEvent = options.onEvent;
  }

  startSession(projectPath: string, prompt: string): SessionRunner {
    if (this.activeSessionId) {
      throw new Error(
        `Cannot start a new session while session ${this.activeSessionId} is active. Stop it first.`
      );
    }
    const id = randomUUID();
    const runner = new SessionRunner({
      id,
      projectPath,
      queryFn: this.queryFn,
      onEvent: this.onEvent,
    });
    this.sessions.set(id, runner);
    this.activeSessionId = id;
    runner.start(prompt);
    return runner;
  }

  getSession(id: string): SessionRunner {
    const runner = this.sessions.get(id);
    if (!runner) throw new Error(`No session with id ${id}`);
    return runner;
  }

  getActiveSession(): SessionRunner | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
  }

  async stopSession(id: string): Promise<void> {
    const runner = this.getSession(id);
    await runner.stop();
    if (this.activeSessionId === id) {
      this.activeSessionId = undefined;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/session-manager.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd "d:/Companion"
git add packages/daemon/src/session-manager.ts packages/daemon/src/session-manager.test.ts
git commit -m "feat(daemon): add SessionManager enforcing one active session"
```

---

## Task 7: Daemon — local HTTP control surface

**Files:**
- Create: `packages/daemon/src/http-server.ts`
- Create: `packages/daemon/src/http-server.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (Task 6); `SessionEvent` (Task 2).
- Produces: `function createHttpServer(manager: SessionManager, eventLog: SessionEvent[]): express.Express`, exposing:
  - `POST /sessions` `{ projectPath, prompt }` → `201 { id, status }`
  - `POST /sessions/:id/prompt` `{ text }` → `204`
  - `POST /sessions/:id/respond` `{ requestId, approved, reason? }` → `204`
  - `POST /sessions/:id/pause` → `204`
  - `POST /sessions/:id/resume` → `204`
  - `POST /sessions/:id/stop` → `204`
  - `GET /sessions/:id/events` → `200 SessionEvent[]`
  - Any thrown error from `SessionManager`/`SessionRunner` → `400 { error: string }`

This is a **local-only dev/test control surface** — it lets this package be exercised end to end without the relay (Plan 2), which will call `SessionManager` directly over its own WebSocket transport instead of through this HTTP layer.

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/src/http-server.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

function createMockAgent() {
  const outgoing = new AsyncQueue<AgentMessage>();
  let canUseTool: ((request: PermissionRequest) => Promise<PermissionResponse>) | undefined;
  const queryFn: QueryFn = ({ options }) => {
    canUseTool = options.canUseTool;
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => outgoing.close()),
    };
    return agentQuery;
  };
  return { queryFn, outgoing, getCanUseTool: () => canUseTool! };
}

describe('HTTP control surface', () => {
  it('drives a full session lifecycle: start, permission, pause, resume, prompt, stop', async () => {
    const agent = createMockAgent();
    const eventLog: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: agent.queryFn,
      onEvent: (e) => eventLog.push(e),
    });
    const app = createHttpServer(manager, eventLog);

    const startRes = await request(app)
      .post('/sessions')
      .send({ projectPath: '/tmp/project', prompt: 'do the thing' });
    expect(startRes.status).toBe(201);
    const sessionId = startRes.body.id as string;

    agent.outgoing.push({ type: 'assistant_text', text: 'On it' });
    await new Promise((resolve) => setImmediate(resolve));

    const eventsRes = await request(app).get(`/sessions/${sessionId}/events`);
    expect(
      eventsRes.body.some((e: SessionEvent) => e.type === 'assistant_text')
    ).toBe(true);

    const canUseTool = agent.getCanUseTool();
    const permissionPromise = canUseTool({ requestId: 'req-1', toolName: 'Bash', input: {} });
    await new Promise((resolve) => setImmediate(resolve));

    const respondRes = await request(app)
      .post(`/sessions/${sessionId}/respond`)
      .send({ requestId: 'req-1', approved: true });
    expect(respondRes.status).toBe(204);
    await expect(permissionPromise).resolves.toEqual({ approved: true });

    const pauseRes = await request(app).post(`/sessions/${sessionId}/pause`);
    expect(pauseRes.status).toBe(204);

    const resumeRes = await request(app).post(`/sessions/${sessionId}/resume`);
    expect(resumeRes.status).toBe(204);

    const promptRes = await request(app)
      .post(`/sessions/${sessionId}/prompt`)
      .send({ text: 'follow up' });
    expect(promptRes.status).toBe(204);

    const stopRes = await request(app).post(`/sessions/${sessionId}/stop`);
    expect(stopRes.status).toBe(204);

    const finalEvents = await request(app).get(`/sessions/${sessionId}/events`);
    expect(finalEvents.body.some((e: SessionEvent) => e.type === 'stopped')).toBe(true);
  });

  it('returns 400 when starting a second session while one is active', async () => {
    const agent = createMockAgent();
    const eventLog: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: agent.queryFn,
      onEvent: (e) => eventLog.push(e),
    });
    const app = createHttpServer(manager, eventLog);

    await request(app).post('/sessions').send({ projectPath: '/tmp/project', prompt: 'first' });
    const secondRes = await request(app)
      .post('/sessions')
      .send({ projectPath: '/tmp/project', prompt: 'second' });

    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toContain('Cannot start a new session');
  });

  it('returns 400 for commands against an unknown session id', async () => {
    const agent = createMockAgent();
    const eventLog: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: agent.queryFn,
      onEvent: (e) => eventLog.push(e),
    });
    const app = createHttpServer(manager, eventLog);

    const res = await request(app).post('/sessions/does-not-exist/pause');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "d:/Companion/packages/daemon"
npx vitest run src/http-server.test.ts
```

Expected: FAIL — `./http-server.js` does not exist.

- [ ] **Step 3: Implement `http-server.ts`**

Create `packages/daemon/src/http-server.ts`:

```ts
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SessionManager } from './session-manager.js';
import type { SessionEvent } from '@companion/protocol';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function createHttpServer(manager: SessionManager, eventLog: SessionEvent[]): Express {
  const app = express();
  app.use(express.json());

  app.post(
    '/sessions',
    asyncHandler(async (req, res) => {
      const { projectPath, prompt } = req.body as { projectPath: string; prompt: string };
      const runner = manager.startSession(projectPath, prompt);
      res.status(201).json({ id: runner.id, status: runner.status });
    })
  );

  app.post(
    '/sessions/:id/prompt',
    asyncHandler(async (req, res) => {
      const { text } = req.body as { text: string };
      manager.getSession(req.params.id).injectPrompt(text);
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/respond',
    asyncHandler(async (req, res) => {
      const { requestId, approved, reason } = req.body as {
        requestId: string;
        approved: boolean;
        reason?: string;
      };
      manager.getSession(req.params.id).respondToPermission(requestId, { approved, reason });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/pause',
    asyncHandler(async (req, res) => {
      await manager.getSession(req.params.id).pause();
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/resume',
    asyncHandler(async (req, res) => {
      manager.getSession(req.params.id).resume();
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/stop',
    asyncHandler(async (req, res) => {
      await manager.stopSession(req.params.id);
      res.status(204).end();
    })
  );

  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
      const events = eventLog.filter((e) => e.sessionId === req.params.id);
      res.status(200).json(events);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  });

  return app;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/http-server.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd "d:/Companion"
git add packages/daemon/src/http-server.ts packages/daemon/src/http-server.test.ts
git commit -m "feat(daemon): add local HTTP control surface for session lifecycle"
```

---

## Task 8: Wire the real Claude Agent SDK and add the daemon entrypoint

**Files:**
- Create: `packages/daemon/src/real-agent-sdk.ts`
- Modify: `packages/daemon/src/index.ts`
- Create: `packages/daemon/README.md`

**Interfaces:**
- Consumes: `QueryFn`, `AgentQuery`, `AgentMessage`, `PermissionRequest`, `PermissionResponse` (Task 4); `SessionManager` (Task 6); `createHttpServer` (Task 7); `query` from `@anthropic-ai/claude-agent-sdk`.
- Produces: `export const realQueryFn: QueryFn` — the one place the real SDK's types meet our port interface. `packages/daemon/src/index.ts` becomes the runnable entrypoint (`npm start` inside `packages/daemon`).

This task has no new automated test: it adapts to a real external API that needs a live Claude Code login/network to exercise, which doesn't belong in the unit/integration suite. It's verified with a manual smoke test (Step 4) and by keeping every prior automated test green.

- [ ] **Step 1: Install the SDK**

```bash
cd "d:/Companion/packages/daemon"
npm install @anthropic-ai/claude-agent-sdk
```

- [ ] **Step 2: Implement the real adapter**

Create `packages/daemon/src/real-agent-sdk.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';

export const realQueryFn: QueryFn = ({ prompt, options }) => {
  async function* toSdkPrompt() {
    for await (const message of prompt) {
      yield { type: 'user' as const, text: message.text };
    }
  }

  const sdkQuery = query({
    prompt: toSdkPrompt(),
    options: {
      cwd: options.cwd,
      canUseTool: async (request: { tool_name: string; arguments: unknown }) => {
        const response = await options.canUseTool({
          requestId: randomUUID(),
          toolName: request.tool_name,
          input: request.arguments,
        });
        return response.approved
          ? { approved: true }
          : { approved: false, reason: response.reason };
      },
    },
  });

  async function* toAgentMessages(): AsyncGenerator<AgentMessage> {
    for await (const message of sdkQuery) {
      yield message as unknown as AgentMessage;
    }
  }

  const agentQuery: AgentQuery = {
    [Symbol.asyncIterator]: () => toAgentMessages(),
    interrupt: async () => {
      await sdkQuery.interrupt();
    },
    close: () => sdkQuery.close(),
  };

  return agentQuery;
};
```

- [ ] **Step 3: Wire the daemon entrypoint**

Replace `packages/daemon/src/index.ts` with:

```ts
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { realQueryFn } from './real-agent-sdk.js';
import type { SessionEvent } from '@companion/protocol';

const PORT = Number(process.env.COMPANION_DAEMON_PORT ?? 4310);

const eventLog: SessionEvent[] = [];
const manager = new SessionManager({
  queryFn: realQueryFn,
  onEvent: (event) => {
    eventLog.push(event);
    console.log(`[${event.sessionId}] ${event.type}`);
  },
});

const app = createHttpServer(manager, eventLog);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Companion daemon control surface listening on http://127.0.0.1:${PORT}`);
});
```

- [ ] **Step 4: Run the full automated suite (regression check)**

```bash
cd "d:/Companion"
npm test
```

Expected: PASS — every test from Tasks 2, 3, 5, 6, 7 still passes (the SDK wiring didn't touch tested code paths).

- [ ] **Step 5: Manual smoke test against the real SDK**

Requires a machine with Claude Code already authenticated (per the spec's stated requirement that the laptop has Claude Code running/configured).

```bash
cd "d:/Companion/packages/daemon"
npm run build
node dist/index.js
```

In a second terminal:

```bash
curl -X POST http://127.0.0.1:4310/sessions \
  -H "Content-Type: application/json" \
  -d "{\"projectPath\": \"d:/Companion\", \"prompt\": \"Say hello and stop.\"}"
```

Expected: a `201` response with a session `id`; the daemon's console logs `assistant_text` / `turn_complete` events. Then:

```bash
curl http://127.0.0.1:4310/sessions/<id>/events
```

Expected: the recorded event list, including the assistant's reply. Stop it with:

```bash
curl -X POST http://127.0.0.1:4310/sessions/<id>/stop
```

- [ ] **Step 6: Write the daemon README**

Create `packages/daemon/README.md`:

```markdown
# @companion/daemon

Owns and drives Claude Code sessions via the Claude Agent SDK, and exposes a
**local-only** HTTP control surface (bound to `127.0.0.1`) for exercising the
session lifecycle without the relay or web app.

## Run

    npm run build
    npm start

Set `COMPANION_DAEMON_PORT` to change the port (default `4310`).

## Endpoints

- `POST /sessions` `{ projectPath, prompt }` — start the one active session
- `POST /sessions/:id/prompt` `{ text }` — inject a follow-up prompt
- `POST /sessions/:id/respond` `{ requestId, approved, reason? }` — answer a
  pending permission request
- `POST /sessions/:id/pause` — interrupt the current turn
- `POST /sessions/:id/resume` — mark the session running again after a pause
- `POST /sessions/:id/stop` — end the session
- `GET /sessions/:id/events` — poll the event log for that session

## Note

This HTTP surface is for local development and testing only. The relay
integration (a later plan) connects to `SessionManager` directly over an
outbound WebSocket — it does not go through this HTTP layer.
```

- [ ] **Step 7: Commit**

```bash
cd "d:/Companion"
git add packages/daemon/src/real-agent-sdk.ts packages/daemon/src/index.ts packages/daemon/README.md packages/daemon/package.json packages/daemon/package-lock.json
git commit -m "feat(daemon): wire the real Claude Agent SDK and add the runnable entrypoint"
```

---

## Plan-level verification

After Task 8, run from the repo root:

```bash
cd "d:/Companion"
npm test
npm run build
```

Expected: all packages build and all tests (protocol: 7, daemon: 3 + 4 + 7 + 3 = 17) pass. This confirms Plan 1's deliverable — a standalone, fully-tested `SessionManager`/`SessionRunner` core plus a working local control surface — is ready for Plan 2 (the relay server) to connect to.
