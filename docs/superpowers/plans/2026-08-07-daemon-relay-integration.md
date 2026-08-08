# Daemon–Relay Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Companion Daemon a persistent, outbound WebSocket connection to the (already-built) Relay Server, so events from a locally-driven `SessionRunner` reach any paired browser and commands from a browser reach the daemon — turning the two previously-separate, already-tested packages into one working end-to-end pipe.

**Architecture:** Add a `RelayClient` to `packages/daemon` that dials the relay's `/ws?token=` endpoint (the same wire protocol `packages/relay` already speaks and tests against), forwards every `SessionManager`-emitted `SessionEvent` as a `{kind:'event', ...}` frame, and dispatches incoming `{kind:'command', ...}` frames into the same `SessionManager` the local HTTP control surface already uses — via one new shared `dispatchCommand` function so the two channels can never drift. A new `device-auth` module gets the daemon its own device token by self-pairing against the relay's already-unauthenticated `/pairing/request-code` endpoint (this is intentional in v1 — see `packages/relay/README.md`'s "bootstraps the first device" note) and persists it locally so restarts don't re-pair.

**Tech Stack:** TypeScript (NodeNext), `ws` (already a `@companion/relay` dependency, added here to `@companion/daemon`), Vitest, Zod schemas from `@companion/protocol`.

## Global Constraints

- Env vars read by the daemon entrypoint: `COMPANION_RELAY_URL` (e.g. `ws://localhost:8787`; unset = relay connectivity disabled entirely, daemon runs exactly as it does today), `COMPANION_DEVICE_NAME` (default: `os.hostname()`), `COMPANION_DEVICE_TOKEN_PATH` (default: `path.join(os.homedir(), '.companion', 'daemon-device.json')`).
- Reconnect backoff for `RelayClient`: start at `500`ms, double on each failed/closed attempt, cap at `10000`ms, reset to `500`ms on a successful `open`. Both bounds are constructor-overridable so tests don't wait on real timers.
- Daemon→relay event frames set `seq: 0` as a placeholder value. The relay assigns and returns the authoritative `seq`; `hub.ts`'s `routeFromDaemon` and `server.ts`'s message handler never read the inbound `seq` on an event frame — this is verified by reading both files, not assumed.
- Every WS frame the daemon *receives* from the relay MUST be parsed with `RelayMessage.parse()` (from `@companion/protocol`) before use — it is untrusted network input, exactly like the relay's own `server.ts` treats inbound frames.
- `ws.on('error', ...)` on the daemon's outbound socket must be attached synchronously, before any other listener, so a socket error can never surface as an unhandled `'error'` event and crash the daemon process — mirrors the fix already applied to the relay's own WS handling.
- The existing local-only HTTP control surface (`packages/daemon/src/http-server.ts`, bound to `127.0.0.1`) is **not** removed or replaced. It stays exactly as documented in `packages/daemon/README.md` ("for local development and testing only"). The relay client is a second, independent channel into the same `SessionManager` — both can be active at once.
- `start_session` is never dispatched from the relay — the relay itself already refuses to route it (`hub.ts`'s `routeFromBrowser` throws on `command.type === 'start_session'`) — but `dispatchCommand` still rejects it defensively rather than assuming that guarantee holds forever.
- Do **not** add a TypeScript project reference from `packages/daemon/tsconfig.json` to `packages/relay`. Every package's `build` script here is plain `tsc -p tsconfig.json` (never `tsc -b`), so `references` entries are inert for compilation — imports resolve via each package's `package.json` `types` field once its `dist` exists. Adding a reference to a non-`composite` project (`packages/relay/tsconfig.json` has no `"composite": true`) risks a spurious compile error for no benefit.
- Root `package.json`'s `build` script must build `@companion/relay` before `@companion/daemon`. Every package's `tsconfig.json` here uses `"include": ["src"]` with no test-file exclusion, so `tsc -p` type-checks `.test.ts` files too — and Task 5 adds a daemon test file that imports `@companion/relay`, which must already be built.

---

### Task 1: Shared command dispatcher

**Files:**
- Create: `packages/daemon/src/command-dispatcher.ts`
- Test: `packages/daemon/src/command-dispatcher.test.ts`
- Modify: `packages/daemon/src/http-server.ts`

**Interfaces:**
- Produces: `dispatchCommand(manager: SessionManager, command: Command): Promise<void>` — applies any non-`start_session` `Command` (from `@companion/protocol`) to the matching `SessionRunner` on the given `SessionManager`. Throws (rejects) on `start_session`, on an unknown `sessionId` (via `SessionManager.getSession`'s existing throw), or on any error the target `SessionRunner` method throws.
- Consumes: `SessionManager` (`packages/daemon/src/session-manager.ts`, already has `getSession(id): SessionRunner`, `stopSession(id): Promise<void>`), `Command`/`SessionEvent` types from `@companion/protocol`, `SessionRunner`'s existing methods (`injectPrompt`, `respondToPermission`, `pause`, `resume`).

This task removes duplicated per-command logic from `http-server.ts` (each route currently re-derives what to call on the runner) by routing every route through the same `dispatchCommand` that Task 4's relay command handler will also use, so local HTTP and the relay can never diverge in how a `Command` is applied.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/command-dispatcher.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { dispatchCommand } from './command-dispatcher.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';

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

describe('dispatchCommand', () => {
  it('rejects start_session', async () => {
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, onEvent: () => {} });
    await expect(
      dispatchCommand(manager, { type: 'start_session', projectPath: '/tmp/project', prompt: 'hi' })
    ).rejects.toThrow('start_session must be issued locally');
  });

  it('dispatches inject_prompt, respond_to_permission, pause, resume, and stop to the right session', async () => {
    const agent = createMockAgent();
    const manager = new SessionManager({ queryFn: agent.queryFn, onEvent: () => {} });
    const runner = manager.startSession('/tmp/project', 'do the thing');

    const permissionPromise = agent.getCanUseTool()({ requestId: 'req-1', toolName: 'Bash', input: {} });
    await new Promise((resolve) => setImmediate(resolve));
    await dispatchCommand(manager, {
      type: 'respond_to_permission',
      sessionId: runner.id,
      requestId: 'req-1',
      approved: true,
    });
    await expect(permissionPromise).resolves.toEqual({ approved: true });

    await dispatchCommand(manager, { type: 'pause', sessionId: runner.id });
    expect(runner.status).toBe('paused');

    await dispatchCommand(manager, { type: 'resume', sessionId: runner.id });
    expect(runner.status).toBe('running');

    await expect(
      dispatchCommand(manager, { type: 'inject_prompt', sessionId: runner.id, text: 'follow up' })
    ).resolves.toBeUndefined();

    await dispatchCommand(manager, { type: 'stop', sessionId: runner.id });
    expect(runner.status).toBe('stopped');
  });

  it('propagates the error for an unknown session id', async () => {
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, onEvent: () => {} });
    await expect(
      dispatchCommand(manager, { type: 'pause', sessionId: 'does-not-exist' })
    ).rejects.toThrow('No session with id does-not-exist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/daemon/`): `npx vitest run src/command-dispatcher.test.ts`
Expected: FAIL — `command-dispatcher.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/command-dispatcher.ts`:

```typescript
import type { Command } from '@companion/protocol';
import type { SessionManager } from './session-manager.js';

/**
 * Applies a Command to the given SessionManager. Shared by the local HTTP
 * control surface (http-server.ts) and the relay client's incoming-command
 * handler (relay-client.ts via main.ts), so the two channels apply commands
 * identically and can never drift.
 */
export async function dispatchCommand(manager: SessionManager, command: Command): Promise<void> {
  switch (command.type) {
    case 'start_session':
      throw new Error('start_session must be issued locally, not dispatched as a Command');
    case 'inject_prompt':
      manager.getSession(command.sessionId).injectPrompt(command.text);
      return;
    case 'respond_to_permission':
      manager
        .getSession(command.sessionId)
        .respondToPermission(command.requestId, { approved: command.approved, reason: command.reason });
      return;
    case 'pause':
      await manager.getSession(command.sessionId).pause();
      return;
    case 'resume':
      manager.getSession(command.sessionId).resume();
      return;
    case 'stop':
      await manager.stopSession(command.sessionId);
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/command-dispatcher.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Refactor http-server.ts to use dispatchCommand**

Replace the contents of `packages/daemon/src/http-server.ts` with:

```typescript
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { SessionManager } from './session-manager.js';
import {
  StartSessionCommand,
  InjectPromptCommand,
  RespondToPermissionCommand,
} from '@companion/protocol';
import type { SessionEvent } from '@companion/protocol';
import { dispatchCommand } from './command-dispatcher.js';

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
      const { projectPath, prompt } = StartSessionCommand.omit({ type: true }).parse(req.body);
      const runner = manager.startSession(projectPath, prompt);
      res.status(201).json({ id: runner.id, status: runner.status });
    })
  );

  app.post(
    '/sessions/:id/prompt',
    asyncHandler(async (req, res) => {
      const { text } = InjectPromptCommand.omit({ type: true, sessionId: true }).parse(req.body);
      await dispatchCommand(manager, { type: 'inject_prompt', sessionId: req.params.id, text });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/respond',
    asyncHandler(async (req, res) => {
      const { requestId, approved, reason } = RespondToPermissionCommand.omit({
        type: true,
        sessionId: true,
      }).parse(req.body);
      await dispatchCommand(manager, {
        type: 'respond_to_permission',
        sessionId: req.params.id,
        requestId,
        approved,
        reason,
      });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/pause',
    asyncHandler(async (req, res) => {
      await dispatchCommand(manager, { type: 'pause', sessionId: req.params.id });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/resume',
    asyncHandler(async (req, res) => {
      await dispatchCommand(manager, { type: 'resume', sessionId: req.params.id });
      res.status(204).end();
    })
  );

  app.post(
    '/sessions/:id/stop',
    asyncHandler(async (req, res) => {
      await dispatchCommand(manager, { type: 'stop', sessionId: req.params.id });
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

- [ ] **Step 6: Run the full daemon suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, including the pre-existing `src/http-server.test.ts` unchanged (it exercises behavior, not internals, so it must still pass without modification).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/command-dispatcher.ts packages/daemon/src/command-dispatcher.test.ts packages/daemon/src/http-server.ts
git commit -m "feat(daemon): extract shared dispatchCommand, route HTTP surface through it"
```

---

### Task 2: Device token bootstrap and persistence

**Files:**
- Create: `packages/daemon/src/device-auth.ts`
- Test: `packages/daemon/src/device-auth.test.ts`

**Interfaces:**
- Produces: `getOrCreateDeviceToken(options: DeviceAuthOptions): Promise<DeviceCredentials>`, `interface DeviceCredentials { token: string; deviceId: string }`, `interface DeviceAuthOptions { relayHttpUrl: string; deviceName: string; tokenPath: string; fetchFn?: FetchLike }`, `type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>`.
- Consumes: nothing from earlier tasks. Talks to the relay's REST pairing endpoints (`POST /pairing/request-code`, `POST /pairing/redeem` — see `packages/relay/src/server.ts` and `packages/relay/README.md`) via HTTP, not the daemon's own code.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/device-auth.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateDeviceToken, type FetchLike } from './device-auth.js';

describe('getOrCreateDeviceToken', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('self-pairs against the relay and persists the token when no token file exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'nested', 'device.json');
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/pairing/request-code')) {
        return { ok: true, status: 201, json: async () => ({ code: '123456', expiresAt: Date.now() + 60_000 }) };
      }
      if (url.endsWith('/pairing/redeem')) {
        expect(JSON.parse(init!.body!)).toEqual({ code: '123456', deviceType: 'daemon', deviceName: 'laptop' });
        return { ok: true, status: 201, json: async () => ({ token: 'secret-token', deviceId: 'device-1' }) };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const credentials = await getOrCreateDeviceToken({
      relayHttpUrl: 'http://localhost:8787',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });

    expect(credentials).toEqual({ token: 'secret-token', deviceId: 'device-1' });
    expect(calls).toEqual(['http://localhost:8787/pairing/request-code', 'http://localhost:8787/pairing/redeem']);

    const persisted = JSON.parse(await readFile(tokenPath, 'utf8'));
    expect(persisted).toEqual({ token: 'secret-token', deviceId: 'device-1' });
  });

  it('reuses a previously persisted token without calling the relay', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'seeded-token', deviceId: 'device-1' }));

    const fetchFn: FetchLike = async () => {
      throw new Error('fetch should not be called when a token file already exists');
    };

    const credentials = await getOrCreateDeviceToken({
      relayHttpUrl: 'http://x',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });
    expect(credentials).toEqual({ token: 'seeded-token', deviceId: 'device-1' });
  });

  it('throws when the relay rejects the pairing code request', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    const fetchFn: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });

    await expect(
      getOrCreateDeviceToken({ relayHttpUrl: 'http://x', deviceName: 'laptop', tokenPath, fetchFn })
    ).rejects.toThrow('Failed to request a pairing code');
  });

  it('throws when the persisted token file is malformed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'only-token-no-device-id' }));

    await expect(
      getOrCreateDeviceToken({
        relayHttpUrl: 'http://x',
        deviceName: 'laptop',
        tokenPath,
        fetchFn: async () => {
          throw new Error('fetch should not be called');
        },
      })
    ).rejects.toThrow('malformed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/device-auth.test.ts`
Expected: FAIL — `device-auth.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `packages/daemon/src/device-auth.ts`:

```typescript
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DeviceCredentials {
  token: string;
  deviceId: string;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface DeviceAuthOptions {
  relayHttpUrl: string;
  deviceName: string;
  tokenPath: string;
  fetchFn?: FetchLike;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/**
 * Returns this daemon's device credentials, reading them from `tokenPath` if
 * present. On first run (no token file yet), self-pairs against the relay:
 * `/pairing/request-code` is intentionally unauthenticated in v1 — it
 * bootstraps the very first device for the single seeded user (see
 * packages/relay/README.md) — so the daemon can mint its own device token
 * with no human pairing step. Later devices (the web app) pair using a code
 * generated from an already-authenticated session instead.
 */
export async function getOrCreateDeviceToken(options: DeviceAuthOptions): Promise<DeviceCredentials> {
  const existing = await readExisting(options.tokenPath);
  if (existing) return existing;

  const fetchFn = options.fetchFn ?? defaultFetch;
  const credentials = await pairNewDevice(options.relayHttpUrl, options.deviceName, fetchFn);
  await persist(options.tokenPath, credentials);
  return credentials;
}

async function readExisting(tokenPath: string): Promise<DeviceCredentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(tokenPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<DeviceCredentials>;
  if (typeof parsed.token !== 'string' || typeof parsed.deviceId !== 'string') {
    throw new Error(`Device token file at ${tokenPath} is malformed`);
  }
  return { token: parsed.token, deviceId: parsed.deviceId };
}

async function pairNewDevice(
  relayHttpUrl: string,
  deviceName: string,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  const codeRes = await fetchFn(`${relayHttpUrl}/pairing/request-code`, { method: 'POST' });
  if (!codeRes.ok) {
    throw new Error(`Failed to request a pairing code from the relay: HTTP ${codeRes.status}`);
  }
  const { code } = (await codeRes.json()) as { code: string };

  const redeemRes = await fetchFn(`${relayHttpUrl}/pairing/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceType: 'daemon', deviceName }),
  });
  if (!redeemRes.ok) {
    throw new Error(`Failed to redeem pairing code with the relay: HTTP ${redeemRes.status}`);
  }
  const { token, deviceId } = (await redeemRes.json()) as { token: string; deviceId: string };
  return { token, deviceId };
}

async function persist(tokenPath: string, credentials: DeviceCredentials): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/device-auth.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/device-auth.ts packages/daemon/src/device-auth.test.ts
git commit -m "feat(daemon): bootstrap and persist a device token by self-pairing with the relay"
```

---

### Task 3: Outbound relay WebSocket client

**Files:**
- Create: `packages/daemon/src/relay-client.ts`
- Test: `packages/daemon/src/relay-client.test.ts`
- Modify: `packages/daemon/package.json` (add `ws` dependency, `@types/ws` devDependency)

**Interfaces:**
- Produces: `class RelayClient` — constructor `(options: RelayClientOptions)`; `connect(): void`; `close(): void`; `sendEvent(sessionId: string, event: SessionEvent): void`. `interface RelayClientOptions { url: string; token: string; onCommand: (command: Command) => void; onOpen?: () => void; onLog?: (message: string) => void; initialBackoffMs?: number; maxBackoffMs?: number }`.
- Consumes: `RelayMessage` (discriminated union), `Command`, `SessionEvent` from `@companion/protocol` (already built by this point — `packages/protocol`).

- [ ] **Step 1: Add dependencies**

Edit `packages/daemon/package.json`: add to `"dependencies"`: `"ws": "^8.18.0"`, and to `"devDependencies"`: `"@types/ws": "^8.18.1"` (matching the exact versions `@companion/relay` already uses). Then from the repo root:

```bash
npm install
```

This updates `package-lock.json` — it must be committed together with `package.json` in this task's commit (a prior plan in this repo broke `npm ci` by forgetting this).

- [ ] **Step 2: Write the failing test**

Create `packages/daemon/src/relay-client.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RelayClient } from './relay-client.js';
import type { Command, SessionEvent } from '@companion/protocol';

function startFakeRelay(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, port });
    });
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForConnection(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => {
    wss.once('connection', (ws) => resolve(ws));
  });
}

describe('RelayClient', () => {
  let wss: WebSocketServer;
  let client: RelayClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('connects with the token in the query string and forwards a sent event', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let receivedUrl = '';
    const serverConnected = new Promise<WebSocket>((resolve) => {
      wss.once('connection', (ws, req) => {
        receivedUrl = req.url ?? '';
        resolve(ws);
      });
    });

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onOpen: () => resolve(),
      });
    });
    client!.connect();

    const [serverSocket] = await Promise.all([serverConnected, clientOpened]);
    expect(receivedUrl).toContain('token=test-token');

    const received = waitForMessage(serverSocket);
    const event: SessionEvent = { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() };
    client!.sendEvent('sess-1', event);
    expect(await received).toMatchObject({ kind: 'event', sessionId: 'sess-1', event });
  });

  it('invokes onCommand when the server sends a command frame', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const commandReceived = new Promise<Command>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: (command) => resolve(command),
      });
    });
    client!.connect();

    const serverSocket = await connected;
    const command: Command = { type: 'pause', sessionId: 'sess-1' };
    serverSocket.send(JSON.stringify({ kind: 'command', sessionId: 'sess-1', command }));

    expect(await commandReceived).toEqual(command);
  });

  it('does not throw when sendEvent is called before the socket is open', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    client = new RelayClient({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onCommand: () => {} });
    // Note: connect() deliberately not called — there is no socket yet.
    expect(() =>
      client!.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() })
    ).not.toThrow();
  });

  it('reconnects with backoff after the server closes the connection', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let connectionCount = 0;
    const secondConnection = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          ws.close();
        } else {
          resolve();
        }
      });
    });

    client = new RelayClient({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 'test-token',
      onCommand: () => {},
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    });
    client.connect();

    await secondConnection;
    expect(connectionCount).toBe(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/relay-client.test.ts`
Expected: FAIL — `relay-client.ts` does not exist yet.

- [ ] **Step 4: Write minimal implementation**

Create `packages/daemon/src/relay-client.ts`:

```typescript
import { WebSocket } from 'ws';
import { RelayMessage, type Command, type SessionEvent } from '@companion/protocol';

export interface RelayClientOptions {
  url: string;
  token: string;
  onCommand: (command: Command) => void;
  onOpen?: () => void;
  onLog?: (message: string) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Persistent outbound WebSocket connection from the daemon to the relay.
 * Forwards SessionEvents out, dispatches Commands in, and reconnects with
 * exponential backoff on any disconnect until close() is called.
 */
export class RelayClient {
  private readonly url: string;
  private readonly token: string;
  private readonly onCommand: (command: Command) => void;
  private readonly onOpenCallback: () => void;
  private readonly onLog: (message: string) => void;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private ws: WebSocket | undefined;
  private backoffMs: number;
  private closed = true;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: RelayClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.onCommand = options.onCommand;
    this.onOpenCallback = options.onOpen ?? (() => {});
    this.onLog = options.onLog ?? (() => {});
    this.initialBackoffMs = options.initialBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.backoffMs = this.initialBackoffMs;
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  sendEvent(sessionId: string, event: SessionEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.onLog(`Dropping event ${event.type} for session ${sessionId}: not connected to relay`);
      return;
    }
    const message: RelayMessage = { kind: 'event', sessionId, seq: 0, event };
    this.ws.send(JSON.stringify(message));
  }

  private openSocket(): void {
    const separator = this.url.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${this.url}${separator}token=${encodeURIComponent(this.token)}`);
    this.ws = ws;

    // Attached before any other listener: an 'error' event with no listener is an
    // uncaught exception that terminates the process.
    ws.on('error', (err) => {
      this.onLog(`Relay connection error: ${err.message}`);
    });

    ws.on('open', () => {
      this.backoffMs = this.initialBackoffMs;
      this.onLog('Connected to relay');
      this.onOpenCallback();
    });

    ws.on('message', (raw) => {
      let parsed: RelayMessage;
      try {
        parsed = RelayMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (parsed.kind === 'command') {
        this.onCommand(parsed.command);
      }
    });

    ws.on('close', () => {
      if (this.closed) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/relay-client.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/package.json package-lock.json packages/daemon/src/relay-client.ts packages/daemon/src/relay-client.test.ts
git commit -m "feat(daemon): add outbound RelayClient with reconnect-with-backoff"
```

---

### Task 4: Wire the daemon entrypoint to the relay

**Files:**
- Create: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/src/index.ts`
- Modify: `packages/daemon/package.json` (`"start"` script)
- Modify: `packages/daemon/README.md`

**Interfaces:**
- Consumes: `SessionManager`, `createHttpServer`, `realQueryFn` (existing), `getOrCreateDeviceToken` (Task 2), `RelayClient` (Task 3), `dispatchCommand` (Task 1).
- Produces: `index.ts` becomes a pure, side-effect-free barrel (mirrors `packages/relay/src/index.ts`'s existing split) re-exporting `SessionManager`, `SessionRunner`, `createHttpServer`, `RelayClient`, `getOrCreateDeviceToken`, `dispatchCommand`, `AsyncQueue`, `realQueryFn`, and the port/device-auth/relay-client types. `main.ts` holds all entrypoint side effects and is what `npm start` runs.

- [ ] **Step 1: Create the new entrypoint**

Create `packages/daemon/src/main.ts`:

```typescript
import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
import { realQueryFn } from './real-agent-sdk.js';
import { getOrCreateDeviceToken } from './device-auth.js';
import { RelayClient } from './relay-client.js';
import { dispatchCommand } from './command-dispatcher.js';
import type { SessionEvent } from '@companion/protocol';

const PORT = Number(process.env.COMPANION_DAEMON_PORT ?? 4310);
const RELAY_URL = process.env.COMPANION_RELAY_URL;
const DEVICE_NAME = process.env.COMPANION_DEVICE_NAME ?? hostname();
const DEVICE_TOKEN_PATH =
  process.env.COMPANION_DEVICE_TOKEN_PATH ?? join(homedir(), '.companion', 'daemon-device.json');

function relayHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http');
}

async function main(): Promise<void> {
  let relayClient: RelayClient | undefined;

  const eventLog: SessionEvent[] = [];
  const manager = new SessionManager({
    queryFn: realQueryFn,
    onEvent: (event) => {
      eventLog.push(event);
      console.log(`[${event.sessionId}] ${event.type}`);
      relayClient?.sendEvent(event.sessionId, event);
    },
  });

  const app = createHttpServer(manager, eventLog);
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Companion daemon control surface listening on http://127.0.0.1:${PORT}`);
  });

  if (RELAY_URL) {
    const { token } = await getOrCreateDeviceToken({
      relayHttpUrl: relayHttpUrl(RELAY_URL),
      deviceName: DEVICE_NAME,
      tokenPath: DEVICE_TOKEN_PATH,
    });

    relayClient = new RelayClient({
      url: RELAY_URL,
      token,
      onLog: (message) => console.log(`[relay] ${message}`),
      onCommand: (command) => {
        void dispatchCommand(manager, command).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!('sessionId' in command)) {
            console.error(`Relay command failed: ${message}`);
            return;
          }
          const errorEvent: SessionEvent = {
            type: 'error',
            sessionId: command.sessionId,
            message,
            at: Date.now(),
          };
          eventLog.push(errorEvent);
          relayClient?.sendEvent(command.sessionId, errorEvent);
        });
      },
    });
    relayClient.connect();
    console.log(`Connecting to relay at ${RELAY_URL}`);
  }
}

main().catch((err) => {
  console.error('Fatal error starting daemon:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Reduce index.ts to a pure barrel**

Replace the contents of `packages/daemon/src/index.ts` with:

```typescript
export { SessionManager } from './session-manager.js';
export { SessionRunner } from './session-runner.js';
export { createHttpServer } from './http-server.js';
export { AsyncQueue } from './async-queue.js';
export { realQueryFn } from './real-agent-sdk.js';
export { getOrCreateDeviceToken } from './device-auth.js';
export type { DeviceCredentials, DeviceAuthOptions, FetchLike } from './device-auth.js';
export { RelayClient } from './relay-client.js';
export type { RelayClientOptions } from './relay-client.js';
export { dispatchCommand } from './command-dispatcher.js';
export type {
  AgentMessage,
  AgentQuery,
  AgentQueryOptions,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
```

- [ ] **Step 3: Point the start script at the new entrypoint**

In `packages/daemon/package.json`, change:

```json
"start": "node dist/index.js",
```

to:

```json
"start": "node dist/main.js",
```

- [ ] **Step 4: Update the README**

Replace `packages/daemon/README.md` with:

```markdown
# @companion/daemon

Owns and drives Claude Code sessions via the Claude Agent SDK. Exposes two
independent control channels into the same `SessionManager`:

- A **local-only** HTTP surface (bound to `127.0.0.1`) for exercising the
  session lifecycle without the relay or web app.
- An **outbound relay client**, when `COMPANION_RELAY_URL` is set: a
  persistent WebSocket to the relay that forwards every `SessionEvent` and
  applies every `Command` the relay routes to this daemon.

## Run

    npm run build
    npm start

## Configuration

- `COMPANION_DAEMON_PORT` — local HTTP surface port (default `4310`).
- `COMPANION_RELAY_URL` — relay WebSocket URL, e.g. `ws://localhost:8787`. If
  unset, the daemon runs exactly as before: local HTTP only, no relay
  connection attempted.
- `COMPANION_DEVICE_NAME` — name this daemon registers as (default: the
  machine's hostname).
- `COMPANION_DEVICE_TOKEN_PATH` — where the daemon persists its relay device
  token after first pairing (default: `~/.companion/daemon-device.json`).

## Endpoints (local HTTP surface)

- `POST /sessions` `{ projectPath, prompt }` — start the one active session
- `POST /sessions/:id/prompt` `{ text }` — inject a follow-up prompt
- `POST /sessions/:id/respond` `{ requestId, approved, reason? }` — answer a
  pending permission request
- `POST /sessions/:id/pause` — interrupt the current turn
- `POST /sessions/:id/resume` — mark the session running again after a pause
- `POST /sessions/:id/stop` — end the session
- `GET /sessions/:id/events` — poll the event log for that session

This HTTP surface is for local development and testing only; it is not
authenticated and only binds to loopback. The relay connection is the
production control channel for the web app.

## Relay connection

On first run with `COMPANION_RELAY_URL` set, the daemon self-pairs: it calls
the relay's `POST /pairing/request-code` (intentionally unauthenticated in
v1 — see `packages/relay/README.md`) and `POST /pairing/redeem` with
`deviceType: 'daemon'`, then persists the returned token to
`COMPANION_DEVICE_TOKEN_PATH` so subsequent restarts reuse it without
re-pairing. It then opens `wss://<relay>/ws?token=<token>` and reconnects
with exponential backoff (500ms, doubling, capped at 10s) on any disconnect.

A command the relay routes to this daemon that fails (e.g. references an
unknown or already-stopped session) is turned into an `error` `SessionEvent`
and sent back over the same connection, so a connected browser always sees
why nothing happened rather than silence.
```

- [ ] **Step 5: Verify the build**

Run (from `packages/daemon/`): `npx tsc -p tsconfig.json`
Expected: succeeds with no errors.

- [ ] **Step 6: Run the full daemon suite**

Run: `npx vitest run`
Expected: PASS (index.ts and main.ts have no dedicated tests — they are wiring, consistent with `packages/relay`'s existing `main.ts`; every function they call is already unit-tested in Tasks 1-3).

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/main.ts packages/daemon/src/index.ts packages/daemon/package.json packages/daemon/README.md
git commit -m "feat(daemon): wire relay client into the entrypoint, split index.ts/main.ts"
```

---

### Task 5: End-to-end integration test and build ordering

**Files:**
- Create: `packages/daemon/src/relay-integration.test.ts`
- Modify: `packages/daemon/package.json` (add `@companion/relay` devDependency)
- Modify: `package.json` (root — fix build order)

**Interfaces:**
- Consumes: `RelayClient` (Task 3, `packages/daemon/src/relay-client.ts`), `createRelayServer`, `InMemoryStore`, `InMemoryPubSub` (all exported from `@companion/relay`'s barrel, `packages/relay/src/index.ts`).

This task proves the two packages actually interoperate over the wire, not just against each package's own test doubles.

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/src/relay-integration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer, InMemoryStore, InMemoryPubSub } from '@companion/relay';
import { RelayClient } from './relay-client.js';
import type { Command, SessionEvent } from '@companion/protocol';

async function pair(httpServer: Server, deviceType: 'daemon' | 'browser', deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send();
  const redeemRes = await request(httpServer)
    .post('/pairing/redeem')
    .send({ code: codeRes.body.code, deviceType, deviceName });
  return redeemRes.body.token as string;
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

describe('daemon <-> relay integration', () => {
  let httpServer: Server;
  let relayClient: RelayClient | undefined;
  let browserWs: WebSocket | undefined;

  afterEach(async () => {
    relayClient?.close();
    browserWs?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('forwards a daemon-emitted event to a connected browser, and a browser command back to the daemon', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const receivedCommands: Command[] = [];
    const daemonOpened = new Promise<void>((resolve) => {
      relayClient = new RelayClient({
        url: `ws://127.0.0.1:${port}`,
        token: daemonToken,
        onCommand: (command) => receivedCommands.push(command),
        onOpen: () => resolve(),
      });
    });
    relayClient!.connect();
    await daemonOpened;

    browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    await new Promise<void>((resolve, reject) => {
      browserWs!.once('open', () => resolve());
      browserWs!.once('error', reject);
    });

    const browserReceived = waitForMessage(browserWs);
    const event: SessionEvent = {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: Date.now(),
    };
    relayClient!.sendEvent('sess-1', event);

    const forwarded = await browserReceived;
    expect(forwarded).toMatchObject({ kind: 'event', sessionId: 'sess-1', event });
    expect(typeof forwarded.seq).toBe('number');

    const command: Command = { type: 'pause', sessionId: 'sess-1' };
    browserWs.send(JSON.stringify({ kind: 'command', sessionId: 'sess-1', command }));

    await expect.poll(() => receivedCommands.length, { timeout: 2000 }).toBeGreaterThan(0);
    expect(receivedCommands[0]).toEqual(command);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/relay-integration.test.ts`
Expected: FAIL — `Cannot find module '@companion/relay' or its corresponding type declarations` (it is not yet a dependency of `@companion/daemon`).

- [ ] **Step 3: Add the relay devDependency and fix build order**

Edit `packages/daemon/package.json`: add to `"devDependencies"`: `"@companion/relay": "*"`.

Edit root `package.json`'s `"build"` script from:

```json
"build": "npm run build -w @companion/protocol && npm run build -w @companion/daemon && npm run build -w @companion/relay"
```

to:

```json
"build": "npm run build -w @companion/protocol && npm run build -w @companion/relay && npm run build -w @companion/daemon"
```

(`@companion/relay` must build before `@companion/daemon`, because this task's test file imports it and every `tsconfig.json` in this repo includes `.test.ts` files in its `tsc -p` build.)

From the repo root:

```bash
npm install
npm run build -w @companion/relay
```

Commit the resulting `package-lock.json` change together with this task (see Task 3's note on why this matters).

- [ ] **Step 4: Confirm it passes**

Run (from `packages/daemon/`): `npx vitest run src/relay-integration.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Run the full monorepo build and test suite from a clean state**

From the repo root:

```bash
npm run build
npm test
```

Expected: both succeed, with `@companion/daemon`'s test count now including `command-dispatcher.test.ts`, `device-auth.test.ts`, `relay-client.test.ts`, and `relay-integration.test.ts` in addition to the pre-existing daemon tests.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/package.json package-lock.json package.json packages/daemon/src/relay-integration.test.ts
git commit -m "test(daemon): add end-to-end daemon<->relay integration test, fix root build order"
```
