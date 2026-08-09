# Multi-Session Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the web app's single-active-session dashboard with a two-tier view — a list of every one of the user's active sessions, and a detail view (today's dashboard) for whichever one is opened — so a developer running Claude Code in several projects at once can see and act on all of them from one phone screen.

**Architecture:** One shared WebSocket connection, owned above a new `react-router` router by `SessionsProvider`, feeds two tiers: a cheap always-live session-summary list (`SessionList` at `/`) and an on-demand full event history for whichever session is open (`SessionDetail` at `/sessions/:id`, today's `Dashboard.tsx` adapted). Two small relay additions support this: `SessionRecord` gains `lastEventAt`/`dismissed`, and `GET /sessions/active` returns an array with a new `POST /sessions/:id/dismiss` alongside it.

**Tech Stack:** TypeScript, React 19, Vite 7, Tailwind CSS v4, `react-router` 8 (new dependency — the current stable major as of 2026-08-08, exports `BrowserRouter`/`Routes`/`Route`/`Link`/`useParams`/`MemoryRouter` directly from the `react-router` package, no separate `react-router-dom` or framework Vite plugin needed for this app's plain-SPA "library mode" usage), Express, `ws`, Vitest, React Testing Library.

## Global Constraints

- No session history beyond "stopped but not yet dismissed" — dismissal is one-way and immediate on success.
- Exactly one WebSocket connection per browser tab, owned above the router by `SessionsProvider`.
- List-tier state (`SessionSummary`) never includes a full per-session event array; only the currently-open detail route holds one.
- `dismissSession` checks `session.userId === device.userId` before mutating anything, matching every other session-scoped store/route call. The `GET /sessions/:id` non-enumerable-404 pattern (identical response whether a session is missing or owned by someone else) applies to the dismiss route too.
- Component/unit tests only (Vitest + React Testing Library) — no Playwright/e2e, matching the existing web app's testing strategy.
- Every `it(...)` test block must contain a real assertion — no empty or trivially-true tests.

---

### Task 1: Relay — `lastEventAt`/`dismissed` fields, `getActiveSessionsForUser`, `dismissSession`

**Files:**
- Modify: `packages/relay/src/store.ts`
- Modify: `packages/relay/src/in-memory-store.ts`
- Modify: `packages/relay/src/in-memory-store.test.ts`
- Modify: `packages/relay/src/hub.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `SessionRecord` gains `lastEventAt: number` and `dismissed: boolean`. `Store.getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>` replaces `Store.getActiveSessionForUser`. `Store.dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>` is new, where `DismissSessionResult = 'ok' | 'not_found' | 'forbidden' | 'not_stopped'`. Task 2 (relay routes) and Task 3 (web API client) both depend on these exact names and the `DismissSessionResult` values.

- [ ] **Step 1: Replace the whole content of `packages/relay/src/store.ts`**

```ts
import type { SessionEvent, SessionStatus } from '@companion/protocol';

export interface User {
  id: string;
  email: string;
  createdAt: number;
}

export interface Device {
  id: string;
  userId: string;
  type: 'daemon' | 'browser';
  name: string;
  tokenHash: string;
  createdAt: number;
}

export interface PairingCode {
  code: string;
  userId: string;
  expiresAt: number;
  consumed: boolean;
}

export interface SessionRecord {
  id: string;
  userId: string;
  daemonDeviceId: string;
  projectPath: string;
  status: SessionStatus;
  startedAt: number;
  lastEventAt: number;
  dismissed: boolean;
}

export interface StoredSessionEvent {
  seq: number;
  sessionId: string;
  event: SessionEvent;
  createdAt: number;
}

export type DismissSessionResult = 'ok' | 'not_found' | 'forbidden' | 'not_stopped';

export interface Store {
  getOrCreateDefaultUser(): Promise<User>;
  createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device>;
  getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined>;
  createPairingCode(userId: string): Promise<PairingCode>;
  consumePairingCode(code: string): Promise<PairingCode | undefined>;
  upsertSession(session: SessionRecord): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>;
  dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>;
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
}
```

- [ ] **Step 2: Replace the whole content of `packages/relay/src/in-memory-store.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';

describe('InMemoryStore', () => {
  it('returns the same default user on repeated calls', async () => {
    const store = new InMemoryStore();
    const first = await store.getOrCreateDefaultUser();
    const second = await store.getOrCreateDefaultUser();
    expect(second.id).toBe(first.id);
  });

  it('creates a device and finds it by token hash', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const device = await store.createDevice({
      userId: user.id,
      type: 'daemon',
      name: 'laptop',
      tokenHash: 'hash-1',
    });
    const found = await store.getDeviceByTokenHash('hash-1');
    expect(found?.id).toBe(device.id);
  });

  it('returns undefined for an unknown token hash', async () => {
    const store = new InMemoryStore();
    expect(await store.getDeviceByTokenHash('does-not-exist')).toBeUndefined();
  });

  it('a pairing code can only be consumed once', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const pairing = await store.createPairingCode(user.id);

    const first = await store.consumePairingCode(pairing.code);
    expect(first?.code).toBe(pairing.code);

    const second = await store.consumePairingCode(pairing.code);
    expect(second).toBeUndefined();
  });

  it('consumePairingCode returns undefined for an expired code', async () => {
    let now = 1_000_000;
    const store = new InMemoryStore(() => now);
    const user = await store.getOrCreateDefaultUser();
    const pairing = await store.createPairingCode(user.id);

    now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute TTL

    expect(await store.consumePairingCode(pairing.code)).toBeUndefined();
  });

  it('appends and retrieves session events in order, filtered by sinceSeq', async () => {
    const store = new InMemoryStore();
    await store.appendSessionEvent('sess-1', {
      type: 'turn_complete',
      sessionId: 'sess-1',
      at: 1,
    });
    const second = await store.appendSessionEvent('sess-1', {
      type: 'turn_complete',
      sessionId: 'sess-1',
      at: 2,
    });

    const all = await store.getSessionEvents('sess-1');
    expect(all).toHaveLength(2);

    const sinceFirst = await store.getSessionEvents('sess-1', all[0].seq);
    expect(sinceFirst).toHaveLength(1);
    expect(sinceFirst[0].seq).toBe(second.seq);
  });

  it('upsertSession and updateSessionStatus round-trip', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });
    await store.updateSessionStatus('sess-1', 'paused');

    const session = await store.getSession('sess-1');
    expect(session?.status).toBe('paused');
  });

  it("appendSessionEvent bumps the owning session's lastEventAt", async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 42 });

    expect((await store.getSession('sess-1'))?.lastEventAt).toBe(42);
  });

  it('getActiveSessionsForUser returns every non-dismissed session for that user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project-a',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });
    await store.upsertSession({
      id: 'sess-2',
      userId: 'user-1',
      daemonDeviceId: 'device-2',
      projectPath: '/tmp/project-b',
      status: 'waiting_permission',
      startedAt: 2,
      lastEventAt: 2,
      dismissed: false,
    });

    const active = await store.getActiveSessionsForUser('user-1');
    expect(active.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('getActiveSessionsForUser includes a stopped session until it is dismissed', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'stopped',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect((await store.getActiveSessionsForUser('user-1')).map((s) => s.id)).toEqual(['sess-1']);

    await store.dismissSession('sess-1', 'user-1');

    expect(await store.getActiveSessionsForUser('user-1')).toEqual([]);
  });

  it('getActiveSessionsForUser only returns sessions belonging to that user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.getActiveSessionsForUser('user-2')).toEqual([]);
  });

  it('dismissSession returns not_found for an unknown session', async () => {
    const store = new InMemoryStore();
    expect(await store.dismissSession('does-not-exist', 'user-1')).toBe('not_found');
  });

  it('dismissSession returns forbidden for a session owned by another user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'stopped',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.dismissSession('sess-1', 'user-2')).toBe('forbidden');
  });

  it('dismissSession returns not_stopped for a session that is still running', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.dismissSession('sess-1', 'user-1')).toBe('not_stopped');
    expect((await store.getSession('sess-1'))?.dismissed).toBe(false);
  });

  it('dismissSession marks a stopped session dismissed and returns ok', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'stopped',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.dismissSession('sess-1', 'user-1')).toBe('ok');
    expect((await store.getSession('sess-1'))?.dismissed).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -w @companion/relay`
Expected: FAIL — `in-memory-store.test.ts` errors because `InMemoryStore` has no `dismissSession` method and `getActiveSessionsForUser` doesn't exist yet (only the old `getActiveSessionForUser` does).

- [ ] **Step 4: Replace the whole content of `packages/relay/src/in-memory-store.ts`**

```ts
import { randomInt, randomUUID } from 'node:crypto';
import type { SessionEvent, SessionStatus } from '@companion/protocol';
import type {
  Device,
  DismissSessionResult,
  PairingCode,
  SessionRecord,
  Store,
  StoredSessionEvent,
  User,
} from './store.js';

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export class InMemoryStore implements Store {
  private users = new Map<string, User>();
  private defaultUserId: string | undefined;
  private devices = new Map<string, Device>();
  private devicesByTokenHash = new Map<string, string>();
  private pairingCodes = new Map<string, PairingCode>();
  private sessions = new Map<string, SessionRecord>();
  private events = new Map<string, StoredSessionEvent[]>();
  private nextSeq = 1;

  constructor(private now: () => number = Date.now) {}

  async getOrCreateDefaultUser(): Promise<User> {
    if (this.defaultUserId) {
      return this.users.get(this.defaultUserId)!;
    }
    const user: User = { id: randomUUID(), email: 'you@example.com', createdAt: this.now() };
    this.users.set(user.id, user);
    this.defaultUserId = user.id;
    return user;
  }

  async createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device> {
    const device: Device = { id: randomUUID(), createdAt: this.now(), ...input };
    this.devices.set(device.id, device);
    this.devicesByTokenHash.set(device.tokenHash, device.id);
    return device;
  }

  async getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined> {
    const id = this.devicesByTokenHash.get(tokenHash);
    return id ? this.devices.get(id) : undefined;
  }

  async createPairingCode(userId: string): Promise<PairingCode> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const pairing: PairingCode = {
      code,
      userId,
      expiresAt: this.now() + PAIRING_CODE_TTL_MS,
      consumed: false,
    };
    this.pairingCodes.set(code, pairing);
    return pairing;
  }

  async consumePairingCode(code: string): Promise<PairingCode | undefined> {
    const pairing = this.pairingCodes.get(code);
    if (!pairing || pairing.consumed || pairing.expiresAt < this.now()) {
      return undefined;
    }
    pairing.consumed = true;
    return pairing;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
    }
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(sessionId);
  }

  /**
   * Every session the user hasn't dismissed: anything not yet stopped, plus
   * anything stopped but not yet dismissed. dismissSession only ever sets
   * `dismissed` on a stopped session, so this single check covers both.
   */
  async getActiveSessionsForUser(userId: string): Promise<SessionRecord[]> {
    const result: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.dismissed) continue;
      result.push(session);
    }
    return result;
  }

  async dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return 'not_found';
    if (session.userId !== userId) return 'forbidden';
    if (session.status !== 'stopped') return 'not_stopped';
    session.dismissed = true;
    return 'ok';
  }

  async appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent> {
    const stored: StoredSessionEvent = {
      seq: this.nextSeq++,
      sessionId,
      event,
      createdAt: this.now(),
    };
    const list = this.events.get(sessionId) ?? [];
    list.push(stored);
    this.events.set(sessionId, list);
    // Keeps the session's "most recently active" marker in sync with the
    // event stream, so list-view sorting never needs to fetch that stream.
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastEventAt = event.at;
    }
    return stored;
  }

  async getSessionEvents(sessionId: string, sinceSeq = 0): Promise<StoredSessionEvent[]> {
    const list = this.events.get(sessionId) ?? [];
    return list.filter((e) => e.seq > sinceSeq);
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -w @companion/relay`
Expected: PASS for all `in-memory-store.test.ts` tests. `server.test.ts` and `hub.test.ts` will fail at this point — that's expected, Step 6 fixes the compile issue in `hub.ts`, and Task 2 fixes `server.test.ts`. Confirm the failures are only in those two files, not in `in-memory-store.test.ts`.

- [ ] **Step 6: Update `hub.ts`'s session-creation call**

In `packages/relay/src/hub.ts`, inside `routeFromDaemon`, find this block (in the `if (event.type === 'session_started')` branch):

```ts
      await this.store.upsertSession({
        id: sessionId,
        userId: connection.userId,
        daemonDeviceId: connection.deviceId,
        projectPath: event.projectPath,
        status: 'running',
        startedAt: event.at,
      });
```

Replace it with:

```ts
      await this.store.upsertSession({
        id: sessionId,
        userId: connection.userId,
        daemonDeviceId: connection.deviceId,
        projectPath: event.projectPath,
        status: 'running',
        startedAt: event.at,
        lastEventAt: event.at,
        dismissed: false,
      });
```

- [ ] **Step 7: Run the full relay test suite and the build**

Run: `npm test -w @companion/relay`
Expected: PASS for `in-memory-store.test.ts` and `hub.test.ts` (its `toMatchObject` assertions don't check for absent fields, so they still pass unmodified). `server.test.ts` will still show 2 failures at this point (the `GET /sessions/active` tests) — Task 2 fixes those; confirm no other test file regressed.

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors (this is what actually catches a missed field on a `SessionRecord` literal, since `vitest run` doesn't type-check).

- [ ] **Step 8: Commit**

```bash
git add packages/relay/src/store.ts packages/relay/src/in-memory-store.ts packages/relay/src/in-memory-store.test.ts packages/relay/src/hub.ts
git commit -m "feat(relay): add lastEventAt/dismissed to SessionRecord, getActiveSessionsForUser, dismissSession"
```

---

### Task 2: Relay — `GET /sessions/active` returns an array, new `POST /sessions/:id/dismiss`, README

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`
- Modify: `packages/relay/README.md`

**Interfaces:**
- Consumes: `Store.getActiveSessionsForUser` and `Store.dismissSession` from Task 1, exact names and `DismissSessionResult` values.
- Produces: `GET /sessions/active` now returns `200` with a JSON array (never `404`). `POST /sessions/:id/dismiss` returns `200 { ok: true }` / `404 { error: 'Unknown session' }` / `409 { error: 'Session is not stopped' }` / `401`. Task 3 (web API client) depends on these exact status codes and the `409` case specifically.

- [ ] **Step 1: In `packages/relay/src/server.test.ts`, replace the `// --- GET /sessions/active ---` section (the last two `it(...)` blocks in the file) with the following, which also adds a `// --- POST /sessions/:id/dismiss ---` section after it**

Find this existing block (currently the last section in the file, ending the `describe('relay server', ...)` block):

```ts
  // --- GET /sessions/active ---

  it('returns the active session for the authenticated device\'s user', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${browserToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'sess-1', status: 'running' });
  });

  it('returns 404 when there is no active session', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No active session' });
  });

  it('returns 401 for GET /sessions/active without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/active');
    expect(res.status).toBe(401);
  });
});
```

Replace that entire block (including the final closing `});` of the `describe`) with:

```ts
  // --- GET /sessions/active ---

  it("returns the authenticated device's active sessions", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${browserToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'sess-1', status: 'running' });
  });

  it('returns an empty array when there is no active session', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 for GET /sessions/active without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/active');
    expect(res.status).toBe(401);
  });

  // --- POST /sessions/:id/dismiss ---

  it('dismisses a stopped session and removes it from the active list', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'stopped', sessionId: 'sess-1', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.status, { timeout: 2000 })
      .toBe('stopped');

    const dismissRes = await request(httpServer)
      .post('/sessions/sess-1/dismiss')
      .set('Authorization', `Bearer ${browserToken}`);
    expect(dismissRes.status).toBe(200);

    const listRes = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${browserToken}`);
    expect(listRes.body).toEqual([]);
  });

  it('returns 409 when dismissing a session that is not stopped', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    const res = await request(httpServer)
      .post('/sessions/sess-1/dismiss')
      .set('Authorization', `Bearer ${browserToken}`);
    expect(res.status).toBe(409);
  });

  it('returns 404 when dismissing an unknown session', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer)
      .post('/sessions/does-not-exist/dismiss')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 401 for POST /sessions/:id/dismiss without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/sessions/sess-1/dismiss');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w @companion/relay`
Expected: FAIL — the rewritten `GET /sessions/active` tests fail against the still-old route (single object / 404), and the new `POST /sessions/:id/dismiss` tests fail with 404 (route doesn't exist).

- [ ] **Step 3: Update the `GET /sessions/active` route in `packages/relay/src/server.ts`**

Find:

```ts
  app.get(
    '/sessions/active',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getActiveSessionForUser(device.userId);
      if (!session) {
        res.status(404).json({ error: 'No active session' });
        return;
      }
      res.status(200).json(session);
    })
  );
```

Replace with:

```ts
  app.get(
    '/sessions/active',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const sessions = await store.getActiveSessionsForUser(device.userId);
      res.status(200).json(sessions);
    })
  );
```

- [ ] **Step 4: Add the new dismiss route, right after the `GET /sessions/:id/events` route and before the error-handling middleware**

Find this existing boundary in `packages/relay/src/server.ts`:

```ts
  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getSession(req.params.id);
      if (!session || session.userId !== device.userId) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      const sinceSeq = req.query.since ? Number(req.query.since) : undefined;
      const events = await store.getSessionEvents(req.params.id, sinceSeq);
      res.status(200).json(events);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
```

Insert a new route between them, so it reads:

```ts
  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getSession(req.params.id);
      if (!session || session.userId !== device.userId) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      const sinceSeq = req.query.since ? Number(req.query.since) : undefined;
      const events = await store.getSessionEvents(req.params.id, sinceSeq);
      res.status(200).json(events);
    })
  );

  app.post(
    '/sessions/:id/dismiss',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await store.dismissSession(req.params.id, device.userId);
      if (result === 'not_found' || result === 'forbidden') {
        // Same response for both, like GET /sessions/:id: a non-owner cannot
        // distinguish "doesn't exist" from "exists but isn't theirs."
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      if (result === 'not_stopped') {
        res.status(409).json({ error: 'Session is not stopped' });
        return;
      }
      res.status(200).json({ ok: true });
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -w @companion/relay`
Expected: PASS for all tests in `server.test.ts`, `in-memory-store.test.ts`, and `hub.test.ts`.

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors.

- [ ] **Step 6: Update `packages/relay/README.md`**

Find:

```markdown
- `GET /sessions/active` — the caller's current non-stopped session (for a
  client that doesn't yet know a session id, e.g. on first load). `404` if
  none.
```

Replace with:

```markdown
- `GET /sessions/active` — every one of the caller's sessions that isn't
  dismissed: anything not yet stopped, plus anything stopped but not yet
  dismissed. `200` with a (possibly empty) JSON array.
- `POST /sessions/:id/dismiss` — marks a stopped session dismissed, removing
  it from `GET /sessions/active`. `200` on success, `409` if the session
  isn't stopped yet, `404` if unknown or not owned by the caller.
```

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts packages/relay/README.md
git commit -m "feat(relay): GET /sessions/active returns an array, add POST /sessions/:id/dismiss"
```

---

### Task 3: Web — `api/sessions.ts`: `getActiveSessions`, `dismissSession`

**Files:**
- Modify: `packages/web/src/api/sessions.ts`
- Modify: `packages/web/src/api/sessions.test.ts`

**Interfaces:**
- Consumes: relay's `GET /sessions/active` (array, Task 2) and `POST /sessions/:id/dismiss` (Task 2).
- Produces: `SessionRecord` (client-side type, gains `lastEventAt: number`), `getActiveSessions(token: string): Promise<SessionRecord[]>`, `dismissSession(token: string, sessionId: string): Promise<void>` (throws `UnauthorizedError` on 401, a generic `Error` with message `'Session is not stopped yet'` on 409, a generic `Error` on any other non-2xx). Task 4 (`use-sessions-store.ts`) depends on these exact names and error behavior.

- [ ] **Step 1: Replace the whole content of `packages/web/src/api/sessions.test.ts`**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getActiveSessions, getSessionEvents, dismissSession, UnauthorizedError } from './sessions';

describe('sessions API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getActiveSessions returns the array on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: 'sess-1', status: 'running' }] }))
    );
    const result = await getActiveSessions('tok-1');
    expect(result).toEqual([{ id: 'sess-1', status: 'running' }]);
  });

  it('getActiveSessions returns an empty array on 200 with no sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    expect(await getActiveSessions('tok-1')).toEqual([]);
  });

  it('getActiveSessions throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(getActiveSessions('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('dismissSession resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(dismissSession('tok-1', 'sess-1')).resolves.toBeUndefined();
  });

  it('dismissSession throws on 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}) })));
    await expect(dismissSession('tok-1', 'sess-1')).rejects.toThrow('not stopped');
  });

  it('dismissSession throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(dismissSession('bad-token', 'sess-1')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('dismissSession URL-encodes the session id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/sessions/sess%20with%20space/dismiss');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await dismissSession('tok-1', 'sess with space');
  });

  it('getSessionEvents includes the since query param when provided', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.toString()).toContain('since=5');
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    await getSessionEvents('tok-1', 'sess-1', 5);
  });

  it('getSessionEvents omits the since query param when not provided', async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.toString()).not.toContain('since=');
      return { ok: true, status: 200, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    await getSessionEvents('tok-1', 'sess-1');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w @companion/web`
Expected: FAIL in `sessions.test.ts` — `getActiveSessions` and `dismissSession` aren't exported yet (only the old `getActiveSession` is).

- [ ] **Step 3: Replace the whole content of `packages/web/src/api/sessions.ts`**

```ts
import type { SessionEvent, SessionStatus } from '@companion/protocol';
import { RELAY_HTTP_URL } from '../config';

export interface SessionRecord {
  id: string;
  userId: string;
  daemonDeviceId: string;
  projectPath: string;
  status: SessionStatus;
  startedAt: number;
  lastEventAt: number;
}

export interface StoredSessionEvent {
  seq: number;
  sessionId: string;
  event: SessionEvent;
  createdAt: number;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Relay rejected the stored device token');
    this.name = 'UnauthorizedError';
  }
}

export async function getActiveSessions(token: string): Promise<SessionRecord[]> {
  const res = await fetch(`${RELAY_HTTP_URL}/sessions/active`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch active sessions: HTTP ${res.status}`);
  }
  return (await res.json()) as SessionRecord[];
}

export async function dismissSession(token: string, sessionId: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/sessions/${encodeURIComponent(sessionId)}/dismiss`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (res.status === 409) {
    throw new Error('Session is not stopped yet');
  }
  if (!res.ok) {
    throw new Error(`Failed to dismiss session: HTTP ${res.status}`);
  }
}

export async function getSessionEvents(
  token: string,
  sessionId: string,
  sinceSeq?: number
): Promise<StoredSessionEvent[]> {
  const url = new URL(`${RELAY_HTTP_URL}/sessions/${encodeURIComponent(sessionId)}/events`);
  if (sinceSeq !== undefined) {
    url.searchParams.set('since', String(sinceSeq));
  }
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch session events: HTTP ${res.status}`);
  }
  return (await res.json()) as StoredSessionEvent[];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w @companion/web`
Expected: PASS for all tests in `sessions.test.ts`. Other web test files (`Dashboard.test.tsx`, `App.test.tsx`) will now fail because they still call the old `getActiveSession` — that's expected; Tasks 7 and 8 fix them. Confirm the failures are isolated to those two files.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/sessions.ts packages/web/src/api/sessions.test.ts
git commit -m "feat(web): api/sessions getActiveSessions (array) and dismissSession"
```

---

### Task 4: Web — `use-sessions-store.ts` hook

**Files:**
- Create: `packages/web/src/use-sessions-store.ts`
- Create: `packages/web/src/use-sessions-store.test.ts`

**Interfaces:**
- Consumes: `getActiveSessions`, `dismissSession` (as `apiDismissSession`), `UnauthorizedError`, `SessionRecord` from `./api/sessions` (Task 3); `useRelayConnection`, `LiveEvent` from `./use-relay-connection` (existing, unchanged); `RELAY_WS_URL` from `./config` (existing, unchanged).
- Produces: `SessionSummary { id: string; projectPath: string; status: SessionStatus; lastEventAt: number }`, `UseSessionsStoreResult { sessions: SessionSummary[]; loaded: boolean; connected: boolean; loadError: string | undefined; dismissSession: (sessionId: string) => Promise<void>; sendCommand: (sessionId: string, command: Command) => void; subscribe: (sessionId: string, handler: (message: LiveEvent) => void) => () => void }`, `useSessionsStore(token: string, onUnauthorized: () => void): UseSessionsStoreResult`. Task 5 (`SessionsProvider`) depends on these exact names and shape.

- [ ] **Step 1: Write `packages/web/src/use-sessions-store.test.ts`**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionsStore } from './use-sessions-store';
import * as sessionsApi from './api/sessions';
import { UnauthorizedError } from './api/sessions';
import * as useRelayConnectionModule from './use-relay-connection';
import type { LiveEvent } from './use-relay-connection';

function mockUseRelayConnection() {
  let capturedOnEvent: ((message: LiveEvent) => void) | undefined;
  let connectedValue = true;
  const sendCommand = vi.fn();
  vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockImplementation((options) => {
    capturedOnEvent = options.onEvent;
    return { connected: connectedValue, sendCommand };
  });
  return {
    emit: (message: LiveEvent) => capturedOnEvent?.(message),
    sendCommand,
    setConnected: (value: boolean) => {
      connectedValue = value;
    },
  };
}

const sessionA: sessionsApi.SessionRecord = {
  id: 'sess-1',
  userId: 'u',
  daemonDeviceId: 'd',
  projectPath: '/tmp/a',
  status: 'running',
  startedAt: 1,
  lastEventAt: 1,
};
const sessionB: sessionsApi.SessionRecord = {
  id: 'sess-2',
  userId: 'u',
  daemonDeviceId: 'd',
  projectPath: '/tmp/b',
  status: 'running',
  startedAt: 2,
  lastEventAt: 2,
};

describe('useSessionsStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the active sessions on mount', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA, sessionB]);
    mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.sessions.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it("updates an existing session's status and lastEventAt from a live event", async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: {
          type: 'permission_request',
          sessionId: 'sess-1',
          requestId: 'r1',
          toolName: 'Bash',
          input: {},
          at: 5,
        },
      });
    });

    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === 'sess-1')).toMatchObject({
        status: 'waiting_permission',
        lastEventAt: 5,
      })
    );
  });

  it('inserts a new session on a live session_started event', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      mock.emit({
        sessionId: 'sess-new',
        seq: 1,
        event: { type: 'session_started', sessionId: 'sess-new', projectPath: '/tmp/new', at: 9 },
      });
    });

    await waitFor(() =>
      expect(result.current.sessions).toContainEqual({
        id: 'sess-new',
        projectPath: '/tmp/new',
        status: 'running',
        lastEventAt: 9,
      })
    );
  });

  it('buffers a live event that arrives before the initial load resolves, then applies it once', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord[]) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord[]>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockReturnValue(activePromise);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 1,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/a', at: 1 },
      });
    });

    await act(async () => {
      resolveActive([]);
      await activePromise;
    });

    expect(result.current.sessions).toEqual([
      { id: 'sess-1', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 },
    ]);
  });

  it('notifies a per-session subscriber exactly once for a buffered event', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord[]) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord[]>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockReturnValue(activePromise);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    const received: LiveEvent[] = [];
    act(() => {
      result.current.subscribe('sess-1', (message) => received.push(message));
    });

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 1,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 1 },
      });
    });

    await act(async () => {
      resolveActive([]);
      await activePromise;
    });

    expect(received).toHaveLength(1);
  });

  it('re-runs discovery when reconnecting after having connected before', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValueOnce([]).mockResolvedValueOnce([sessionA]);
    const mock = mockUseRelayConnection();

    const { result, rerender } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.sessions).toEqual([]);

    mock.setConnected(false);
    rerender();
    mock.setConnected(true);
    rerender();

    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(['sess-1']));
  });

  it('calls onUnauthorized when the initial load is rejected with 401', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockRejectedValue(new UnauthorizedError());
    mockUseRelayConnection();
    const onUnauthorized = vi.fn();

    renderHook(() => useSessionsStore('bad-token', onUnauthorized));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it('dismissSession removes the session from state on success', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    vi.spyOn(sessionsApi, 'dismissSession').mockResolvedValue(undefined);
    mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await act(async () => {
      await result.current.dismissSession('sess-1');
    });

    expect(result.current.sessions).toEqual([]);
  });

  it('dismissSession re-throws a non-401 error and leaves state unchanged', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    vi.spyOn(sessionsApi, 'dismissSession').mockRejectedValue(new Error('Session is not stopped yet'));
    mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await expect(result.current.dismissSession('sess-1')).rejects.toThrow('not stopped');
    expect(result.current.sessions).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w @companion/web`
Expected: FAIL — `use-sessions-store.test.ts` errors because `./use-sessions-store` doesn't exist yet.

- [ ] **Step 3: Write `packages/web/src/use-sessions-store.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
import { RELAY_WS_URL } from './config';
import { getActiveSessions, dismissSession as apiDismissSession, UnauthorizedError } from './api/sessions';
import { useRelayConnection, type LiveEvent } from './use-relay-connection';

export interface SessionSummary {
  id: string;
  projectPath: string;
  status: SessionStatus;
  lastEventAt: number;
}

/**
 * Mirrors packages/relay/src/hub.ts's STATUS_BY_EVENT_TYPE exactly, including
 * the deliberate omission of command_failed (a recoverable command failure
 * must not change what this UI shows as the session's status). This is now
 * the single place this map is duplicated on the web side.
 */
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  turn_complete: 'running',
  stopped: 'stopped',
  error: 'stopped',
};

export interface UseSessionsStoreResult {
  sessions: SessionSummary[];
  loaded: boolean;
  connected: boolean;
  loadError: string | undefined;
  dismissSession: (sessionId: string) => Promise<void>;
  sendCommand: (sessionId: string, command: Command) => void;
  subscribe: (sessionId: string, handler: (message: LiveEvent) => void) => () => void;
}

export function useSessionsStore(token: string, onUnauthorized: () => void): UseSessionsStoreResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const sessionsRef = useRef<SessionSummary[]>([]);
  const loadedRef = useRef(false);
  const pendingLiveEventsRef = useRef<LiveEvent[]>([]);
  const loadGenerationRef = useRef(0);
  const subscribersRef = useRef<Map<string, Set<(message: LiveEvent) => void>>>(new Map());
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const setSessionsState = useCallback((next: SessionSummary[]) => {
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  const notifySubscribers = useCallback((message: LiveEvent) => {
    const handlers = subscribersRef.current.get(message.sessionId);
    if (!handlers) return;
    for (const handler of handlers) handler(message);
  }, []);

  /**
   * Applies one live event to the session-summary list. Does NOT notify
   * per-session subscribers — that happens exactly once, at arrival time, in
   * handleLiveEvent below. Called a second time for buffered events (via
   * drainBufferedLiveEvents), which must NOT re-notify subscribers or a
   * mounted SessionDetail would receive the same event twice.
   */
  const updateSessionsFromEvent = useCallback(
    (message: LiveEvent) => {
      if (message.event.type === 'session_started') {
        const next = sessionsRef.current.filter((s) => s.id !== message.sessionId);
        next.push({
          id: message.sessionId,
          projectPath: message.event.projectPath,
          status: 'running',
          lastEventAt: message.event.at,
        });
        setSessionsState(next);
        return;
      }
      const existing = sessionsRef.current.find((s) => s.id === message.sessionId);
      // An event for a session this list doesn't know about yet — nothing to
      // update.
      if (!existing) return;
      const nextStatus = STATUS_BY_EVENT_TYPE[message.event.type] ?? existing.status;
      setSessionsState(
        sessionsRef.current.map((s) =>
          s.id === message.sessionId ? { ...s, status: nextStatus, lastEventAt: message.event.at } : s
        )
      );
    },
    [setSessionsState]
  );

  const drainBufferedLiveEvents = useCallback(() => {
    const buffered = pendingLiveEventsRef.current;
    pendingLiveEventsRef.current = [];
    if (buffered.length === 0) return;
    const ordered = [...buffered].sort((a, b) => a.seq - b.seq);
    for (const message of ordered) {
      setLoadError(undefined);
      updateSessionsFromEvent(message);
    }
  }, [updateSessionsFromEvent]);

  const handleLiveEvent = useCallback(
    (message: LiveEvent) => {
      // Fans out to this session's detail view (if one is mounted) exactly
      // once per arrival, regardless of whether the list tier is still
      // loading — the detail view does its own independent buffering.
      notifySubscribers(message);
      if (!loadedRef.current) {
        pendingLiveEventsRef.current.push(message);
        return;
      }
      setLoadError(undefined);
      updateSessionsFromEvent(message);
    },
    [notifySubscribers, updateSessionsFromEvent]
  );

  const loadSessions = useCallback(async () => {
    const generation = (loadGenerationRef.current += 1);
    loadedRef.current = false;
    try {
      const active = await getActiveSessions(token);
      if (generation !== loadGenerationRef.current) return;
      setSessionsState(
        active.map((s) => ({ id: s.id, projectPath: s.projectPath, status: s.status, lastEventAt: s.lastEventAt }))
      );
      setLoadError(undefined);
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorizedRef.current();
        return;
      }
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGenerationRef.current) {
        loadedRef.current = true;
        setLoaded(true);
        drainBufferedLiveEvents();
      }
    }
  }, [token, setSessionsState, drainBufferedLiveEvents]);

  useEffect(() => {
    void loadSessions();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [loadSessions]);

  const { connected, sendCommand } = useRelayConnection({
    url: RELAY_WS_URL,
    token,
    onEvent: handleLiveEvent,
    onLog: (message) => console.log('[relay]', message),
  });

  const isFirstConnect = useRef(true);
  useEffect(() => {
    if (!connected) return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    // The list is cheap to reload in full, so a reconnect just re-runs
    // discovery rather than diffing what changed while the socket was down
    // — simpler, and correct for sessions that started, stopped, or changed
    // status during the gap.
    void loadSessions();
  }, [connected, loadSessions]);

  const dismissSessionFn = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await apiDismissSession(token, sessionId);
        setSessionsState(sessionsRef.current.filter((s) => s.id !== sessionId));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorizedRef.current();
          return;
        }
        throw err;
      }
    },
    [token, setSessionsState]
  );

  const subscribe = useCallback((sessionId: string, handler: (message: LiveEvent) => void): (() => void) => {
    let handlers = subscribersRef.current.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      subscribersRef.current.set(sessionId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
      if (handlers && handlers.size === 0) {
        subscribersRef.current.delete(sessionId);
      }
    };
  }, []);

  return { sessions, loaded, connected, loadError, dismissSession: dismissSessionFn, sendCommand, subscribe };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w @companion/web`
Expected: PASS for all tests in `use-sessions-store.test.ts`.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/use-sessions-store.ts packages/web/src/use-sessions-store.test.ts
git commit -m "feat(web): add useSessionsStore hook (shared connection, session-summary list, subscribe)"
```

---

### Task 5: Web — `SessionsProvider.tsx` (context wrapper)

**Files:**
- Create: `packages/web/src/SessionsProvider.tsx`
- Create: `packages/web/src/SessionsProvider.test.tsx`

**Interfaces:**
- Consumes: `useSessionsStore`, `UseSessionsStoreResult` from `./use-sessions-store` (Task 4).
- Produces: `SessionsProvider({ token, onUnauthorized, children }): JSX.Element`, `useSessions(): UseSessionsStoreResult` (throws if called outside a `SessionsProvider`). Tasks 6, 7, and 8 all depend on these exact names — `SessionList` and `SessionDetail` call `useSessions()`, and their tests mock `vi.spyOn(sessionsProviderModule, 'useSessions')`.

- [ ] **Step 1: Write `packages/web/src/SessionsProvider.test.tsx`**

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionsProvider, useSessions } from './SessionsProvider';
import * as sessionsApi from './api/sessions';
import * as useRelayConnectionModule from './use-relay-connection';

function Consumer() {
  const { sessions, loaded } = useSessions();
  if (!loaded) return <p>loading</p>;
  return <p>{sessions.length} sessions</p>;
}

describe('SessionsProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provides the sessions store to descendants', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(
      <SessionsProvider token="tok-1" onUnauthorized={() => {}}>
        <Consumer />
      </SessionsProvider>
    );

    expect(await screen.findByText('0 sessions')).toBeInTheDocument();
  });

  it('useSessions throws when called outside a SessionsProvider', () => {
    // Suppress the React error-boundary console.error noise this specific,
    // expected throw produces.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow('useSessions must be used within a SessionsProvider');
    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w @companion/web`
Expected: FAIL — `SessionsProvider.test.tsx` errors because `./SessionsProvider` doesn't exist yet.

- [ ] **Step 3: Write `packages/web/src/SessionsProvider.tsx`**

```tsx
import { createContext, useContext, type ReactNode } from 'react';
import { useSessionsStore, type UseSessionsStoreResult } from './use-sessions-store';

const SessionsContext = createContext<UseSessionsStoreResult | undefined>(undefined);

export interface SessionsProviderProps {
  token: string;
  onUnauthorized: () => void;
  children: ReactNode;
}

export function SessionsProvider({ token, onUnauthorized, children }: SessionsProviderProps) {
  const store = useSessionsStore(token, onUnauthorized);
  return <SessionsContext.Provider value={store}>{children}</SessionsContext.Provider>;
}

export function useSessions(): UseSessionsStoreResult {
  const context = useContext(SessionsContext);
  if (!context) {
    throw new Error('useSessions must be used within a SessionsProvider');
  }
  return context;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w @companion/web`
Expected: PASS for all tests in `SessionsProvider.test.tsx`.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/SessionsProvider.tsx packages/web/src/SessionsProvider.test.tsx
git commit -m "feat(web): add SessionsProvider context wrapper around useSessionsStore"
```

---

### Task 6: Web — `sortSessions`, `formatRelativeTime`, `SessionList.tsx`, add `react-router`

**Files:**
- Modify: `packages/web/package.json` (add `react-router` dependency)
- Modify: `packages/web/src/SessionStatusBar.tsx` (export `STATUS_LABEL`)
- Create: `packages/web/src/sort-sessions.ts`
- Create: `packages/web/src/sort-sessions.test.ts`
- Create: `packages/web/src/format-relative-time.ts`
- Create: `packages/web/src/format-relative-time.test.ts`
- Create: `packages/web/src/SessionList.tsx`
- Create: `packages/web/src/SessionList.test.tsx`

**Interfaces:**
- Consumes: `useSessions` from `./SessionsProvider` (Task 5); `SessionSummary` from `./use-sessions-store` (Task 4); `Link` from `react-router`.
- Produces: `sortSessions(sessions: SessionSummary[]): SessionSummary[]`, `formatRelativeTime(atMs: number, nowMs?: number): string`, `SessionStatusBar`'s `STATUS_LABEL: Record<SessionStatus, string>` (now exported), `SessionList` default export (rendered at `/` in Task 8). Task 8 depends on `SessionList`'s default export.

- [ ] **Step 1: Add `react-router` to `packages/web/package.json`**

In the `"dependencies"` block, add it alongside the existing entries:

```json
  "dependencies": {
    "@companion/protocol": "*",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router": "^8.3.0"
  },
```

Run: `npm install` (from the repo root — this is an npm workspaces monorepo, so installing from the root resolves and updates the single root `package-lock.json`)
Expected: `react-router` and its transitive dependencies appear in `node_modules` and in `package-lock.json`; no errors.

- [ ] **Step 2: Export `STATUS_LABEL` from `packages/web/src/SessionStatusBar.tsx`**

Find:

```ts
const STATUS_LABEL: Record<SessionStatus, string> = {
```

Replace with:

```ts
export const STATUS_LABEL: Record<SessionStatus, string> = {
```

- [ ] **Step 3: Write `packages/web/src/sort-sessions.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { sortSessions } from './sort-sessions';
import type { SessionSummary } from './use-sessions-store';

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return { id: 'sess', projectPath: '/tmp', status: 'running', lastEventAt: 0, ...overrides };
}

describe('sortSessions', () => {
  it('puts waiting_permission sessions ahead of everything else', () => {
    const sessions = [
      session({ id: 'a', status: 'running', lastEventAt: 100 }),
      session({ id: 'b', status: 'waiting_permission', lastEventAt: 1 }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('sorts within a tier by lastEventAt descending', () => {
    const sessions = [session({ id: 'old', lastEventAt: 1 }), session({ id: 'new', lastEventAt: 100 })];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const sessions = [session({ id: 'a', lastEventAt: 1 }), session({ id: 'b', lastEventAt: 2 })];
    const original = [...sessions];
    sortSessions(sessions);
    expect(sessions).toEqual(original);
  });
});
```

- [ ] **Step 4: Write `packages/web/src/format-relative-time.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './format-relative-time';

describe('formatRelativeTime', () => {
  const now = 1_000_000_000;

  it('returns "just now" for under a minute', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });

  it('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });

  it('formats days', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });

  it('clamps a future timestamp to "just now" instead of a negative duration', () => {
    expect(formatRelativeTime(now + 10_000, now)).toBe('just now');
  });
});
```

- [ ] **Step 5: Write `packages/web/src/SessionList.test.tsx`**

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SessionList from './SessionList';
import * as sessionsProviderModule from './SessionsProvider';
import type { SessionSummary } from './use-sessions-store';

function mockSessions(overrides: Partial<ReturnType<typeof sessionsProviderModule.useSessions>> = {}) {
  const dismissSession = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [],
    loaded: true,
    connected: true,
    loadError: undefined,
    dismissSession,
    sendCommand: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  });
  return { dismissSession };
}

function renderList() {
  return render(
    <MemoryRouter>
      <SessionList />
    </MemoryRouter>
  );
}

describe('SessionList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when there are no active sessions', () => {
    mockSessions();
    renderList();
    expect(screen.getByText('No active sessions.')).toBeInTheDocument();
  });

  it('shows a loading state before the initial load resolves', () => {
    mockSessions({ loaded: false });
    renderList();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('sorts a waiting_permission session ahead of a more recently active one', () => {
    const sessions: SessionSummary[] = [
      { id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 100 },
      { id: 'sess-b', projectPath: '/tmp/b', status: 'waiting_permission', lastEventAt: 1 },
    ];
    mockSessions({ sessions });
    renderList();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('/tmp/b');
    expect(items[1]).toHaveTextContent('/tmp/a');
  });

  it('shows the attention badge for a waiting_permission session', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'waiting_permission', lastEventAt: 1 }],
    });
    renderList();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('links each card to its session detail route', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/sessions/sess-a');
  });

  it('shows a Dismiss button only for stopped sessions', () => {
    mockSessions({
      sessions: [
        { id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 },
        { id: 'sess-b', projectPath: '/tmp/b', status: 'running', lastEventAt: 2 },
      ],
    });
    renderList();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('removes the card after a successful dismiss', async () => {
    const { dismissSession } = mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 }],
    });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dismissSession).toHaveBeenCalledWith('sess-a');
  });

  it('shows an inline error when dismiss fails, without removing the card', async () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 }],
      dismissSession: vi.fn().mockRejectedValue(new Error('Session is not stopped yet')),
    });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Session is not stopped yet');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('shows a banner when the initial list load failed', () => {
    mockSessions({ loadError: 'HTTP 500' });
    renderList();
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
```

- [ ] **Step 6: Run the tests and confirm they fail**

Run: `npm test -w @companion/web`
Expected: FAIL — `sort-sessions.test.ts`, `format-relative-time.test.ts`, and `SessionList.test.tsx` all error because those modules don't exist yet.

- [ ] **Step 7: Write `packages/web/src/sort-sessions.ts`**

```ts
import type { SessionSummary } from './use-sessions-store';

/**
 * Sessions waiting on a permission decision always sort first, regardless of
 * activity time — that's the one state where being buried below the fold
 * means a missed decision. Within a tier, most-recently-active first.
 */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const aWaiting = a.status === 'waiting_permission';
    const bWaiting = b.status === 'waiting_permission';
    if (aWaiting !== bWaiting) return aWaiting ? -1 : 1;
    return b.lastEventAt - a.lastEventAt;
  });
}
```

- [ ] **Step 8: Write `packages/web/src/format-relative-time.ts`**

```ts
export function formatRelativeTime(atMs: number, nowMs: number = Date.now()): string {
  const diffSeconds = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (diffSeconds < 60) return 'just now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
```

- [ ] **Step 9: Write `packages/web/src/SessionList.tsx`**

```tsx
import { useState } from 'react';
import { Link } from 'react-router';
import { useSessions } from './SessionsProvider';
import { sortSessions } from './sort-sessions';
import { formatRelativeTime } from './format-relative-time';
import { STATUS_LABEL } from './SessionStatusBar';

export default function SessionList() {
  const { sessions, loaded, connected, loadError, dismissSession } = useSessions();
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({});

  async function handleDismiss(sessionId: string) {
    setDismissErrors((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      await dismissSession(sessionId);
    } catch (err) {
      setDismissErrors((prev) => ({ ...prev, [sessionId]: err instanceof Error ? err.message : String(err) }));
    }
  }

  if (!loaded) {
    return <p className="text-slate-400 p-4">Loading…</p>;
  }

  const sorted = sortSessions(sessions);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-700' : 'bg-red-700'}`}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>

      {loadError && (
        <p role="alert" className="bg-red-900 text-red-100 rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      {sorted.length === 0 && <p className="text-slate-400">No active sessions.</p>}

      <ul className="space-y-2">
        {sorted.map((session) => (
          <li key={session.id} className="bg-slate-800 rounded-md p-4">
            <Link to={`/sessions/${session.id}`} className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {STATUS_LABEL[session.status]}
                  {session.status === 'waiting_permission' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-700">Needs attention</span>
                  )}
                </p>
                <p className="text-sm text-slate-400">{session.projectPath}</p>
              </div>
              <span className="text-xs text-slate-500">{formatRelativeTime(session.lastEventAt)}</span>
            </Link>
            {session.status === 'stopped' && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => handleDismiss(session.id)}
                  className="text-xs px-3 py-1 rounded-md bg-slate-700"
                >
                  Dismiss
                </button>
                {dismissErrors[session.id] && (
                  <p role="alert" className="text-xs text-red-400 mt-1">
                    {dismissErrors[session.id]}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 10: Run the tests and confirm they pass**

Run: `npm test -w @companion/web`
Expected: PASS for `sort-sessions.test.ts`, `format-relative-time.test.ts`, and `SessionList.test.tsx`.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors.

- [ ] **Step 11: Commit**

```bash
git add packages/web/package.json package-lock.json packages/web/src/SessionStatusBar.tsx packages/web/src/sort-sessions.ts packages/web/src/sort-sessions.test.ts packages/web/src/format-relative-time.ts packages/web/src/format-relative-time.test.ts packages/web/src/SessionList.tsx packages/web/src/SessionList.test.tsx
git commit -m "feat(web): add SessionList view, sortSessions, formatRelativeTime, react-router dependency"
```

---

### Task 7: Web — `SessionDetail.tsx` (replaces `Dashboard.tsx`)

**Files:**
- Delete: `packages/web/src/Dashboard.tsx`
- Delete: `packages/web/src/Dashboard.test.tsx`
- Create: `packages/web/src/SessionDetail.tsx`
- Create: `packages/web/src/SessionDetail.test.tsx`

**Interfaces:**
- Consumes: `useSessions` from `./SessionsProvider` (Task 5); `SessionSummary` from `./use-sessions-store` (Task 4); `getSessionEvents`, `UnauthorizedError` from `./api/sessions` (Task 3, unchanged this task); `useParams`, `Link` from `react-router` (Task 6 added the dependency); `SessionStatusBar`, `ActivityFeed`, `ModifiedFilesPanel`, `PermissionPrompt`, `PromptInjectionBox`, `SessionControls` (existing, unchanged).
- Produces: `SessionDetail` default export, `SessionDetailProps { token: string; onUnauthorized: () => void }`. Task 8 depends on this default export and prop shape.

- [ ] **Step 1: Delete the old Dashboard files**

```bash
git rm packages/web/src/Dashboard.tsx packages/web/src/Dashboard.test.tsx
```

- [ ] **Step 2: Write `packages/web/src/SessionDetail.test.tsx`**

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import SessionDetail from './SessionDetail';
import * as sessionsApi from './api/sessions';
import { UnauthorizedError } from './api/sessions';
import * as sessionsProviderModule from './SessionsProvider';
import type { LiveEvent } from './use-relay-connection';
import type { SessionSummary } from './use-sessions-store';

const activeSummary: SessionSummary = {
  id: 'sess-1',
  projectPath: '/tmp/project',
  status: 'running',
  lastEventAt: 1,
};

function mockSessions(overrides: Partial<ReturnType<typeof sessionsProviderModule.useSessions>> = {}) {
  const handlers = new Map<string, (message: LiveEvent) => void>();
  const sendCommand = vi.fn();
  const subscribe = vi.fn((sessionId: string, handler: (message: LiveEvent) => void) => {
    handlers.set(sessionId, handler);
    return () => handlers.delete(sessionId);
  });
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [activeSummary],
    loaded: true,
    connected: true,
    loadError: undefined,
    dismissSession: vi.fn(),
    sendCommand,
    subscribe,
    ...overrides,
  });
  return {
    sendCommand,
    emit: (message: LiveEvent) => handlers.get(message.sessionId)?.(message),
  };
}

function renderDetail(props: { token?: string; onUnauthorized?: () => void; path?: string } = {}) {
  const { token = 'tok-1', onUnauthorized = () => {}, path = '/sessions/sess-1' } = props;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sessions/:id" element={<SessionDetail token={token} onUnauthorized={onUnauthorized} />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SessionDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and renders the session history on mount', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 1 },
        createdAt: 1,
      },
    ]);
    mockSessions();

    renderDetail();

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
  });

  it('appends a live event received through subscribe', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockSessions();

    renderDetail();
    await screen.findByText('Running');

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'live update', at: 2 },
      });
    });

    expect(await screen.findByText('live update')).toBeInTheDocument();
  });

  it('shows a PermissionPrompt for a pending request and sends the response', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockSessions();

    renderDetail();
    await screen.findByText('Running');

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: {
          type: 'permission_request',
          sessionId: 'sess-1',
          requestId: 'req-1',
          toolName: 'Bash',
          input: {},
          at: 2,
        },
      });
    });

    const approveButton = await screen.findByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    expect(mock.sendCommand).toHaveBeenCalledWith('sess-1', {
      type: 'respond_to_permission',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    });
  });

  it('does not show a PermissionPrompt once the request has been resolved', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockSessions();

    renderDetail();
    await screen.findByText('Running');

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: {
          type: 'permission_request',
          sessionId: 'sess-1',
          requestId: 'req-1',
          toolName: 'Bash',
          input: {},
          at: 2,
        },
      });
    });
    await screen.findByRole('button', { name: /approve/i });

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 3,
        event: { type: 'permission_resolved', sessionId: 'sess-1', requestId: 'req-1', approved: true, at: 3 },
      });
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument());
  });

  it('calls onUnauthorized when the history fetch is rejected with 401', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockRejectedValue(new UnauthorizedError());
    mockSessions();
    const onUnauthorized = vi.fn();

    renderDetail({ onUnauthorized });

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it('shows a distinct error state when the history load fails', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockRejectedValue(
      new Error('Failed to fetch session events: HTTP 500')
    );
    mockSessions();

    renderDetail();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to fetch session events: HTTP 500');
  });

  it('re-fetches events since the last-seen seq after reconnecting', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          seq: 3,
          sessionId: 'sess-1',
          event: { type: 'assistant_text', sessionId: 'sess-1', text: 'missed while offline', at: 3 },
          createdAt: 3,
        },
      ]);

    function tree(connected: boolean) {
      vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
        sessions: [activeSummary],
        loaded: true,
        connected,
        loadError: undefined,
        dismissSession: vi.fn(),
        sendCommand: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      });
      return (
        <MemoryRouter initialEntries={['/sessions/sess-1']}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetail token="tok-1" onUnauthorized={() => {}} />} />
          </Routes>
        </MemoryRouter>
      );
    }

    const { rerender } = render(tree(true));
    await screen.findByText('Running');

    rerender(tree(false));
    rerender(tree(true));

    expect(await screen.findByText('missed while offline')).toBeInTheDocument();
  });

  it('shows "Session not found" when the id is not in the shared sessions list', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    mockSessions({ sessions: [] });

    renderDetail();

    expect(await screen.findByText('Session not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sessions/i })).toHaveAttribute('href', '/');
  });

  it('shows a loading state while the shared session list has not loaded yet', () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    mockSessions({ loaded: false, sessions: [] });

    renderDetail();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test -w @companion/web`
Expected: FAIL — `SessionDetail.test.tsx` errors because `./SessionDetail` doesn't exist yet.

- [ ] **Step 4: Write `packages/web/src/SessionDetail.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router';
import type { Command, SessionEvent } from '@companion/protocol';
import { getSessionEvents, UnauthorizedError } from './api/sessions';
import { useSessions } from './SessionsProvider';
import type { LiveEvent } from './use-relay-connection';
import SessionStatusBar from './SessionStatusBar';
import ActivityFeed from './ActivityFeed';
import ModifiedFilesPanel from './ModifiedFilesPanel';
import PermissionPrompt from './PermissionPrompt';
import PromptInjectionBox from './PromptInjectionBox';
import SessionControls from './SessionControls';

export interface SessionDetailProps {
  token: string;
  onUnauthorized: () => void;
}

export default function SessionDetail({ token, onUnauthorized }: SessionDetailProps) {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? '';
  const { sessions, loaded: sessionsLoaded, connected, sendCommand, subscribe } = useSessions();

  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const historyLoadedRef = useRef(false);
  const pendingLiveEventsRef = useRef<LiveEvent[]>([]);
  const loadGenerationRef = useRef(0);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  /**
   * No sessionId filtering needed here, unlike the pre-multi-session
   * Dashboard: `subscribe` (below) only ever calls this handler for events
   * belonging to `sessionId` — that filtering already happened once,
   * centrally, in use-sessions-store.ts.
   */
  const handleLiveEvent = useCallback((message: LiveEvent) => {
    if (!historyLoadedRef.current) {
      pendingLiveEventsRef.current.push(message);
      return;
    }
    setLoadError(undefined);
    if (message.event.type === 'session_started') {
      setLastSeq(message.seq);
      setEvents([message.event]);
      return;
    }
    setLastSeq((prev) => Math.max(prev, message.seq));
    setEvents((prev) => [...prev, message.event]);
  }, []);

  const drainBufferedLiveEvents = useCallback(
    (minSeq: number) => {
      const buffered = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      if (buffered.length === 0) return;
      const late = buffered.filter((message) => message.seq > minSeq).sort((a, b) => a.seq - b.seq);
      for (const message of late) {
        handleLiveEvent(message);
      }
    },
    [handleLiveEvent]
  );

  // Registered before the history fetch below is kicked off, so a live event
  // that arrives while that fetch is in flight is never missed.
  useEffect(() => {
    return subscribe(sessionId, handleLiveEvent);
  }, [sessionId, subscribe, handleLiveEvent]);

  const loadHistory = useCallback(async () => {
    const generation = (loadGenerationRef.current += 1);
    historyLoadedRef.current = false;
    let historySeq = 0;
    try {
      const history = await getSessionEvents(token, sessionId);
      if (generation !== loadGenerationRef.current) return;
      historySeq = history.length > 0 ? history[history.length - 1].seq : 0;
      setEvents(history.map((h) => h.event));
      setLastSeq(historySeq);
      setLoadError(undefined);
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorizedRef.current();
        return;
      }
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGenerationRef.current) {
        historyLoadedRef.current = true;
        setHistoryLoaded(true);
        drainBufferedLiveEvents(historySeq);
      }
    }
  }, [token, sessionId, drainBufferedLiveEvents]);

  useEffect(() => {
    void loadHistory();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [loadHistory]);

  const isFirstConnect = useRef(true);
  useEffect(() => {
    if (!connected) return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    void (async () => {
      try {
        const gap = await getSessionEvents(token, sessionId, lastSeq);
        if (gap.length === 0) return;
        setEvents((prev) => [...prev, ...gap.map((g) => g.event)]);
        setLastSeq(gap[gap.length - 1].seq);
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorizedRef.current();
      }
    })();
  }, [connected]);

  function handleSend(command: Command) {
    sendCommand(sessionId, command);
  }

  if (!historyLoaded || !sessionsLoaded) {
    return <p className="text-slate-400 p-4">Loading…</p>;
  }

  const summary = sessions.find((s) => s.id === sessionId);

  if (!summary) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-4 max-w-lg mx-auto">
        <p className="text-slate-400">Session not found.</p>
        <Link to="/" className="text-blue-400 underline">
          ← Back to sessions
        </Link>
      </div>
    );
  }

  const permissionRequest = findPendingPermissionRequest(events);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-4 max-w-lg mx-auto">
      <Link to="/" className="text-sm text-blue-400 underline">
        ← Back to sessions
      </Link>

      {loadError && (
        <p role="alert" className="bg-red-900 text-red-100 rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      <SessionStatusBar status={summary.status} projectPath={summary.projectPath} connected={connected} />

      {permissionRequest && (
        <PermissionPrompt
          sessionId={sessionId}
          requestId={permissionRequest.requestId}
          toolName={permissionRequest.toolName}
          input={permissionRequest.input}
          onSend={handleSend}
        />
      )}

      <SessionControls sessionId={sessionId} status={summary.status} onSend={handleSend} />
      <PromptInjectionBox
        sessionId={sessionId}
        disabled={summary.status === 'waiting_permission'}
        onSend={handleSend}
      />

      <div>
        <h2 className="text-sm font-semibold text-slate-400 mb-2">Modified files</h2>
        <ModifiedFilesPanel events={events} />
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-400 mb-2">Activity</h2>
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}

function findPendingPermissionRequest(
  events: SessionEvent[]
): { requestId: string; toolName: string; input: unknown } | undefined {
  const resolvedRequestIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'permission_resolved') {
      resolvedRequestIds.add(event.requestId);
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'permission_request' && !resolvedRequestIds.has(event.requestId)) {
      return { requestId: event.requestId, toolName: event.toolName, input: event.input };
    }
  }
  return undefined;
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm test -w @companion/web`
Expected: PASS for all tests in `SessionDetail.test.tsx`. `App.test.tsx` still fails at this point — Task 8 fixes it.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/SessionDetail.tsx packages/web/src/SessionDetail.test.tsx
git commit -m "feat(web): replace Dashboard with route-driven SessionDetail"
```

(The deletions of `Dashboard.tsx`/`Dashboard.test.tsx` from Step 1's `git rm` are already staged and will be included in this commit.)

---

### Task 8: Web — wire up `App.tsx`, `vite.config.ts` SPA fallback, README

**Files:**
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/web/README.md`

**Interfaces:**
- Consumes: `SessionsProvider` (Task 5), `SessionList` (Task 6), `SessionDetail`/`SessionDetailProps` (Task 7), `BrowserRouter`/`Routes`/`Route` from `react-router` (Task 6 added the dependency).
- Produces: the fully wired app — nothing downstream depends on this task, it is the integration point.

- [ ] **Step 1: Update `packages/web/src/App.test.tsx`**

Replace the whole file with:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as pairingApi from './api/pairing';
import * as sessionsApi from './api/sessions';
import { clearStoredCredentials, storeCredentials } from './storage';
import * as useRelayConnectionModule from './use-relay-connection';

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearStoredCredentials();
  });

  it('shows PairingScreen when there are no stored credentials', () => {
    render(<App />);
    expect(screen.getByText('Pair this device')).toBeInTheDocument();
  });

  it('shows the session list when credentials are already stored', async () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(<App />);

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('switches to the session list after pairing succeeds', async () => {
    vi.spyOn(pairingApi, 'redeemPairingCode').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText(/enter pairing code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test -w @companion/web`
Expected: FAIL — `App.test.tsx` still exercises the old single-Dashboard `App.tsx`, so `getActiveSessions` is never called and "No active sessions." never renders.

- [ ] **Step 3: Replace the whole content of `packages/web/src/App.tsx`**

```tsx
import { useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import PairingScreen from './PairingScreen';
import SessionList from './SessionList';
import SessionDetail from './SessionDetail';
import { SessionsProvider } from './SessionsProvider';
import { clearStoredCredentials, getStoredCredentials } from './storage';

export default function App() {
  const [credentials, setCredentials] = useState(() => getStoredCredentials());

  if (!credentials) {
    return <PairingScreen onPaired={() => setCredentials(getStoredCredentials())} />;
  }

  const handleUnauthorized = () => {
    clearStoredCredentials();
    setCredentials(undefined);
  };

  return (
    <SessionsProvider token={credentials.token} onUnauthorized={handleUnauthorized}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<SessionList />} />
          <Route
            path="/sessions/:id"
            element={<SessionDetail token={credentials.token} onUnauthorized={handleUnauthorized} />}
          />
        </Routes>
      </BrowserRouter>
    </SessionsProvider>
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npm test -w @companion/web`
Expected: PASS for every test file in `packages/web` — this is the first point since Task 3 where the whole package's test suite is green again.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors, and the build output includes the PWA files (`dist/manifest.webmanifest`, `dist/registerSW.js`).

- [ ] **Step 5: Add the PWA service worker's SPA navigation fallback in `packages/web/vite.config.ts`**

Find:

```ts
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Claude Companion',
        short_name: 'Companion',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
      },
    }),
```

Replace with:

```ts
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Claude Companion',
        short_name: 'Companion',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
      },
      workbox: {
        // The app now has real client-side routes (/sessions/:id); without
        // this, a direct or offline-cached navigation to one falls through
        // to a 404 instead of the SPA shell that client-side routing needs.
        navigateFallback: '/index.html',
      },
    }),
```

- [ ] **Step 6: Rebuild and confirm the PWA output is still produced correctly**

Run: `npm run build -w @companion/web`
Expected: PASS, `dist/manifest.webmanifest` and `dist/registerSW.js` both present (same check as the original PWA setup plan), no warnings about `navigateFallback`.

- [ ] **Step 7: Update `packages/web/README.md`**

Find:

```markdown
## Follow-up (not in this plan)
```

Insert a new section immediately before it:

```markdown
## Views

Two client-side routes (`react-router`), both behind the pairing gate in
`App.tsx`:

- `/` — `SessionList`: every one of the user's active sessions (including
  stopped-but-not-yet-dismissed ones), sorted with anything waiting on a
  permission decision first, then by most recent activity.
- `/sessions/:id` — `SessionDetail`: the full live view of one session
  (activity feed, modified files, permission prompt, controls) — this is
  what `Dashboard` used to be before multi-session support.

Both share a single WebSocket connection, owned by `SessionsProvider`
(`src/SessionsProvider.tsx` + `src/use-sessions-store.ts`) above the router:
the relay broadcasts every event for every one of a user's sessions to every
one of their browser connections unscoped, so `SessionList` and
`SessionDetail` both read off the same stream rather than opening their own.

## Follow-up (not in this plan)
```

- [ ] **Step 8: Run the whole monorepo's tests and build once more, end to end**

Run: `npm test` (from the repo root)
Expected: PASS across all four packages (`@companion/protocol`, `@companion/daemon`, `@companion/relay`, `@companion/web`).

Run: `npm run build` (from the repo root)
Expected: PASS across all four packages, with `packages/web/dist/manifest.webmanifest` and `packages/web/dist/registerSW.js` present.

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/App.test.tsx packages/web/vite.config.ts packages/web/README.md
git commit -m "feat(web): wire up SessionsProvider + router in App, add SPA navigateFallback"
```
