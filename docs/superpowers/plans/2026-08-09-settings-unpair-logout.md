# Settings / Unpair / Logout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a paired browser view its own device info and unpair itself — revoking its token server-side, force-closing any other live tab using it, and returning to the pairing screen.

**Architecture:** Unpair and logout are the same single action (there is no separate login step; the device token is the credential). Two new relay endpoints (`GET /devices/me`, `POST /devices/unpair`) sit alongside the existing pairing/session routes; a new `SettingsScreen` reached via a `/settings` route calls them and, on success, reuses the app's existing "clear credentials, show pairing screen" transition.

**Tech Stack:** TypeScript, Express (relay), React 19 + react-router v8 (web), Vitest.

## Global Constraints

- No changes to `packages/protocol` — neither new endpoint takes a request body, so no new Zod schemas are needed.
- `Connection` interface (`packages/relay/src/hub.ts`) gains exactly one new method, `close(): void`; no other public API on `ConnectionHub` changes shape.
- `ConnectionHub`'s existing constructor signature (`store, pubsub, graceMs?, now?`) is unchanged.
- Follows the existing Tailwind dark-theme styling and inline-conditional-render UX patterns already established in `PairingScreen.tsx` / `SessionList.tsx` — no new UI dependencies (no modal library, no icon library).
- Unpair scopes to the calling device only: neither endpoint takes a device-id URL parameter, and there is no device-list/management UI in this feature.
- Unpair = logout: one action, one code path. There is no separate "clear local storage but keep the token valid" flow.
- "Paired since" is rendered as a plain absolute date via `toLocaleDateString()`, not the existing relative-time helper (`format-relative-time.ts`), which is built for "how recently did this update," not "when did this happen once."

---

### Task 1: Relay — `Store.deleteDevice` and `ConnectionHub.disconnectDevice`

**Files:**
- Modify: `packages/relay/src/store.ts`
- Modify: `packages/relay/src/in-memory-store.ts`
- Modify: `packages/relay/src/in-memory-store.test.ts`
- Modify: `packages/relay/src/hub.ts`
- Modify: `packages/relay/src/hub.test.ts`

**Interfaces:**
- Produces: `Store.deleteDevice(deviceId: string): Promise<void>` — idempotent, no-op if the device doesn't exist. `Connection.close(): void` — new required member on the existing `Connection` interface. `ConnectionHub.disconnectDevice(deviceId: string): void` — force-closes every live connection registered under that deviceId by calling each one's `close()`; does not call `unregister()` itself (the transport's own close handling does that).
- Consumes: nothing new from other tasks.

- [ ] **Step 1: Write the failing tests for `Store.deleteDevice`**

Add these two tests to `packages/relay/src/in-memory-store.test.ts`, right after the existing `'returns undefined for an unknown token hash'` test (after line 28):

```ts
  it('deleteDevice removes the device so its token no longer authenticates', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const device = await store.createDevice({
      userId: user.id,
      type: 'browser',
      name: 'phone',
      tokenHash: 'hash-2',
    });

    await store.deleteDevice(device.id);

    expect(await store.getDeviceByTokenHash('hash-2')).toBeUndefined();
  });

  it('deleteDevice is a no-op for an unknown device id', async () => {
    const store = new InMemoryStore();
    await expect(store.deleteDevice('does-not-exist')).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- in-memory-store`
Expected: FAIL — `store.deleteDevice is not a function` (TypeScript will also flag this once you try to build, since `deleteDevice` isn't on the `Store` interface yet).

- [ ] **Step 3: Add `deleteDevice` to the `Store` interface**

In `packages/relay/src/store.ts`, the `Store` interface currently reads (lines 45-63):

```ts
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

Add `deleteDevice` right after `getDeviceByTokenHash`:

```ts
export interface Store {
  getOrCreateDefaultUser(): Promise<User>;
  createDevice(input: {
    userId: string;
    type: 'daemon' | 'browser';
    name: string;
    tokenHash: string;
  }): Promise<Device>;
  getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined>;
  deleteDevice(deviceId: string): Promise<void>;
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

- [ ] **Step 4: Implement `deleteDevice` in `InMemoryStore`**

In `packages/relay/src/in-memory-store.ts`, add this method right after `getDeviceByTokenHash` (after line 52, before `createPairingCode`):

```ts
  async deleteDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    this.devices.delete(deviceId);
    this.devicesByTokenHash.delete(device.tokenHash);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- in-memory-store`
Expected: PASS (all tests in the file, including the 2 new ones)

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/store.ts packages/relay/src/in-memory-store.ts packages/relay/src/in-memory-store.test.ts
git commit -m "feat(relay): add Store.deleteDevice for revoking a paired device"
```

- [ ] **Step 7: Write the failing tests for `ConnectionHub.disconnectDevice`**

`packages/relay/src/hub.test.ts` has a shared `fakeConnection` helper at the top of the file (lines 6-16) used by every test in the file:

```ts
function fakeConnection(overrides: Partial<Connection> = {}): Connection & { sent: RelayHubMessage[] } {
  const sent: RelayHubMessage[] = [];
  return {
    deviceId: 'device-1',
    userId: 'user-1',
    deviceType: 'browser',
    send: (message) => sent.push(message),
    sent,
    ...overrides,
  };
}
```

Replace it with this version, which adds a default no-op `close()` (so all ~20 existing call sites keep compiling once `Connection` requires `close`) plus a `closed` flag the new tests can assert on:

```ts
function fakeConnection(overrides: Partial<Connection> = {}): Connection & { sent: RelayHubMessage[]; closed: { value: boolean } } {
  const sent: RelayHubMessage[] = [];
  const closed = { value: false };
  return {
    deviceId: 'device-1',
    userId: 'user-1',
    deviceType: 'browser',
    send: (message) => sent.push(message),
    close: () => {
      closed.value = true;
    },
    sent,
    closed,
    ...overrides,
  };
}
```

Then add these three tests at the end of the file, immediately before the final closing `});` of the `describe('ConnectionHub', ...)` block (i.e. right after the existing `'does not append a duplicate stopped event for a session that is already stopped'` test):

```ts

  // --- disconnectDevice (used when a device is unpaired) ---

  it('disconnectDevice closes every live connection for that device', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const tabA = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    const tabB = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    hub.register(tabA);
    hub.register(tabB);

    hub.disconnectDevice('browser-1');

    expect(tabA.closed.value).toBe(true);
    expect(tabB.closed.value).toBe(true);
  });

  it('disconnectDevice does not close connections belonging to a different device', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const target = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    const other = fakeConnection({ deviceId: 'browser-2', deviceType: 'browser' });
    hub.register(target);
    hub.register(other);

    hub.disconnectDevice('browser-1');

    expect(target.closed.value).toBe(true);
    expect(other.closed.value).toBe(false);
  });

  it('disconnectDevice is a no-op for a device with no live connections', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);

    expect(() => hub.disconnectDevice('does-not-exist')).not.toThrow();
  });
```

- [ ] **Step 8: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- hub.test`
Expected: FAIL — `hub.disconnectDevice is not a function`, and a TypeScript error once built, since `close` isn't required by `Connection` yet and `disconnectDevice` doesn't exist on `ConnectionHub`.

- [ ] **Step 9: Add `close()` to `Connection` and implement `disconnectDevice`**

In `packages/relay/src/hub.ts`, the `Connection` interface currently reads (lines 5-10):

```ts
export interface Connection {
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceType: 'daemon' | 'browser';
  send(message: RelayHubMessage): void;
}
```

Change it to:

```ts
export interface Connection {
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceType: 'daemon' | 'browser';
  send(message: RelayHubMessage): void;
  close(): void;
}
```

Then add `disconnectDevice` to `ConnectionHub` right after the existing `unregister` method (after line 64, before `private allConnections()`):

```ts
  /**
   * Force-closes every live connection currently authenticated as `deviceId`. Used when a
   * device is unpaired: closing triggers the transport's own close handling (e.g. the
   * WebSocket 'close' event in server.ts), which calls `unregister()` for normal cleanup —
   * this method does not call `unregister()` itself, to avoid racing that natural teardown.
   */
  disconnectDevice(deviceId: string): void {
    const set = this.connections.get(deviceId);
    if (!set) return;
    for (const connection of set) {
      connection.close();
    }
  }
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- hub.test`
Expected: PASS (all tests in the file, including the 3 new ones)

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors — this will fail here if `server.ts`'s `Connection` object literal doesn't yet supply `close`; that's expected and gets fixed in Task 2. If the build fails ONLY on `server.ts`'s missing `close` property, that's fine — the files this task owns (`store.ts`, `in-memory-store.ts`, `hub.ts`, and their tests) still need to type-check and test cleanly on their own, which `npm test -w @companion/relay -- hub.test` and `-- in-memory-store` already confirmed.

- [ ] **Step 11: Commit**

```bash
git add packages/relay/src/hub.ts packages/relay/src/hub.test.ts
git commit -m "feat(relay): add ConnectionHub.disconnectDevice to force-close a device's live connections"
```

---

### Task 2: Relay — `GET /devices/me` and `POST /devices/unpair` endpoints

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`
- Modify: `packages/relay/README.md`

**Interfaces:**
- Consumes: `Store.deleteDevice(deviceId: string): Promise<void>` (Task 1), `ConnectionHub.disconnectDevice(deviceId: string): void` (Task 1), `Connection.close(): void` (Task 1).
- Produces: `GET /devices/me` → `200 { id, type, name, createdAt }` or `401`. `POST /devices/unpair` → `200 { ok: true }` or `401`. Both used by Task 3's `api/devices.ts`.

- [ ] **Step 1: Write the failing tests**

Add these five tests to `packages/relay/src/server.test.ts`, right after the existing `'returns 401 for POST /sessions/:id/dismiss without an Authorization header'` test and before the final closing `});` of the `describe('relay server', ...)` block:

```ts

  // --- GET /devices/me ---

  it("returns the authenticated device's own info", async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'browser', name: 'phone' });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(Number));
    expect(res.body).not.toHaveProperty('tokenHash');
    expect(res.body).not.toHaveProperty('userId');
  });

  it('returns 401 for GET /devices/me without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/devices/me');
    expect(res.status).toBe(401);
  });

  // --- POST /devices/unpair ---

  it('unpairs the device: the endpoint succeeds and the token stops authenticating', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');

    const unpairRes = await request(httpServer).post('/devices/unpair').set('Authorization', `Bearer ${token}`);
    expect(unpairRes.status).toBe(200);
    expect(unpairRes.body).toEqual({ ok: true });

    const followUp = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);
    expect(followUp.status).toBe(401);
  });

  it('returns 401 for POST /devices/unpair without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/devices/unpair');
    expect(res.status).toBe(401);
  });

  it('force-closes every other live connection authenticated as the unpaired device', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const token = await pair(httpServer, 'browser', 'phone');

    // Two tabs sharing the same paired browser's token.
    const tabA = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const tabB = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(tabA, tabB);
    await Promise.all([waitForOpen(tabA), waitForOpen(tabB)]);

    const tabACloses = new Promise<number>((resolve) => tabA.once('close', (code) => resolve(code)));
    const tabBCloses = new Promise<number>((resolve) => tabB.once('close', (code) => resolve(code)));

    const unpairRes = await request(httpServer).post('/devices/unpair').set('Authorization', `Bearer ${token}`);
    expect(unpairRes.status).toBe(200);

    expect(await tabACloses).toBe(4403);
    expect(await tabBCloses).toBe(4403);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- server.test`
Expected: FAIL — `GET /devices/me` and `POST /devices/unpair` don't exist yet (404s where 200/401 are expected).

- [ ] **Step 3: Wire `close()` into the WebSocket connection object**

In `packages/relay/src/server.ts`, the WebSocket handler currently builds the `Connection` object like this (lines 166-171):

```ts
        const connection: Connection = {
          deviceId: device.id,
          userId: device.userId,
          deviceType: device.type,
          send: (message) => ws.send(JSON.stringify(message)),
        };
```

Change it to:

```ts
        const connection: Connection = {
          deviceId: device.id,
          userId: device.userId,
          deviceType: device.type,
          send: (message) => ws.send(JSON.stringify(message)),
          close: () => ws.close(4403, 'Device unpaired'),
        };
```

- [ ] **Step 4: Add the two new routes**

In `packages/relay/src/server.ts`, the `/sessions/:id/dismiss` route is immediately followed by the generic error-handling middleware (lines 113-139):

```ts
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

Insert the two new routes between them, so the file reads:

```ts
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

  app.get(
    '/devices/me',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      res.status(200).json({
        id: device.id,
        type: device.type,
        name: device.name,
        createdAt: device.createdAt,
      });
    })
  );

  app.post(
    '/devices/unpair',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      hub.disconnectDevice(device.id);
      await store.deleteDevice(device.id);
      res.status(200).json({ ok: true });
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- server.test`
Expected: PASS (all tests in the file, including the 5 new ones)

- [ ] **Step 6: Run the full relay test suite and build**

Run: `npm test -w @companion/relay`
Expected: PASS — this also confirms Task 1's `hub.test.ts`/`in-memory-store.test.ts` still pass alongside this task's changes.

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors — this is the first point where the `Connection` object literal in `server.ts` supplies `close`, so the build error possible at the end of Task 1 is resolved here.

- [ ] **Step 7: Update the relay README**

In `packages/relay/README.md`, the `## REST endpoints` section currently reads (lines 16-40):

```markdown
## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /sessions/active` — every one of the caller's sessions that isn't
  dismissed: anything not yet stopped, plus anything stopped but not yet
  dismissed. `200` with a (possibly empty) JSON array.
- `POST /sessions/:id/dismiss` — marks a stopped session dismissed, removing
  it from `GET /sessions/active`. `200` on success, `409` if the session
  isn't stopped yet, `404` if unknown or not owned by the caller.
- `GET /sessions/:id` — current session status (for reconnect/catch-up).
- `GET /sessions/:id/events?since=<seq>` — session event history.

All four `/sessions*` routes require `Authorization: Bearer <device-token>`;
unauthenticated requests get `401`. `GET /sessions/active` isn't scoped to a
single session id, so it always succeeds for an authenticated caller:
`200` with a JSON array, empty when the caller has no active sessions.
`GET /sessions/:id`, `GET /sessions/:id/events`, and
`POST /sessions/:id/dismiss` only serve sessions belonging to that device's
user; anything else (missing, or owned by someone else) returns
`404 Unknown session` (never `403`, so session ids cannot be enumerated).
`POST /sessions/:id/dismiss` additionally returns `409` if the session
exists but hasn't stopped yet.
```

Replace it with:

```markdown
## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /devices/me` — the calling device's own `{ id, type, name, createdAt }`
  (never includes `tokenHash` or `userId`).
- `POST /devices/unpair` — revokes the calling device's token so it can
  never authenticate again, and force-closes any other live WebSocket
  connections currently authenticated as that device. `200 { ok: true }`
  on success. There is no way to unpair a device other than the one making
  the request — the target is always the caller, identified by its own
  bearer token.
- `GET /sessions/active` — every one of the caller's sessions that isn't
  dismissed: anything not yet stopped, plus anything stopped but not yet
  dismissed. `200` with a (possibly empty) JSON array.
- `POST /sessions/:id/dismiss` — marks a stopped session dismissed, removing
  it from `GET /sessions/active`. `200` on success, `409` if the session
  isn't stopped yet, `404` if unknown or not owned by the caller.
- `GET /sessions/:id` — current session status (for reconnect/catch-up).
- `GET /sessions/:id/events?since=<seq>` — session event history.

`GET /devices/me`, `POST /devices/unpair`, and all four `/sessions*` routes
require `Authorization: Bearer <device-token>`; unauthenticated requests get
`401`. `GET /sessions/active` isn't scoped to a single session id, so it
always succeeds for an authenticated caller: `200` with a JSON array, empty
when the caller has no active sessions. `GET /sessions/:id`,
`GET /sessions/:id/events`, and `POST /sessions/:id/dismiss` only serve
sessions belonging to that device's user; anything else (missing, or owned
by someone else) returns `404 Unknown session` (never `403`, so session ids
cannot be enumerated). `POST /sessions/:id/dismiss` additionally returns
`409` if the session exists but hasn't stopped yet.
```

Then in the `## WebSocket` section, the first paragraph currently reads (lines 44-49):

```markdown
Connect to `/ws?token=<device-token>` (query-param auth, because browsers
cannot set headers on a WebSocket handshake — REST calls use the
`Authorization` header instead). Daemons send `{kind:'event', ...}`
messages; browsers send `{kind:'command', ...}` messages. The server
routes events to every browser connection for the same user, and commands
to the daemon connections of the device that owns the target session.
```

Add one sentence after it:

```markdown
Connect to `/ws?token=<device-token>` (query-param auth, because browsers
cannot set headers on a WebSocket handshake — REST calls use the
`Authorization` header instead). Daemons send `{kind:'event', ...}`
messages; browsers send `{kind:'command', ...}` messages. The server
routes events to every browser connection for the same user, and commands
to the daemon connections of the device that owns the target session. A
connection is force-closed with code `4403` if its device is unpaired
(`POST /devices/unpair`) while still connected.
```

- [ ] **Step 8: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts packages/relay/README.md
git commit -m "feat(relay): add GET /devices/me and POST /devices/unpair endpoints"
```

---

### Task 3: Web — `api/devices.ts` client

**Files:**
- Create: `packages/web/src/api/devices.ts`
- Test: `packages/web/src/api/devices.test.ts`

**Interfaces:**
- Consumes: `RELAY_HTTP_URL` from `../config` (existing); `UnauthorizedError` from `./sessions` (existing, reused rather than re-declared — `api/sessions.ts` already defines this class and `use-sessions-store.ts`/`SessionDetail.tsx` already do `instanceof UnauthorizedError` checks against it).
- Produces: `DeviceInfo { id: string; type: 'daemon' | 'browser'; name: string; createdAt: number }`, `getDevice(token: string): Promise<DeviceInfo>`, `unpairDevice(token: string): Promise<void>` — both consumed by Task 4's `SettingsScreen.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/api/devices.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getDevice, unpairDevice } from './devices';
import { UnauthorizedError } from './sessions';

describe('devices API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getDevice returns the device info on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: 'dev-1', type: 'browser', name: 'phone', createdAt: 123 }),
      }))
    );
    const result = await getDevice('tok-1');
    expect(result).toEqual({ id: 'dev-1', type: 'browser', name: 'phone', createdAt: 123 });
  });

  it('getDevice throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(getDevice('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('getDevice throws on a non-401 error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(getDevice('tok-1')).rejects.toThrow('HTTP 500');
  });

  it('unpairDevice resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(unpairDevice('tok-1')).resolves.toBeUndefined();
  });

  it('unpairDevice throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(unpairDevice('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('unpairDevice sends a Bearer authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await unpairDevice('tok-1');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- api/devices`
Expected: FAIL — `./devices` doesn't exist yet.

- [ ] **Step 3: Implement `api/devices.ts`**

Create `packages/web/src/api/devices.ts`:

```ts
import { RELAY_HTTP_URL } from '../config';
import { UnauthorizedError } from './sessions';

export interface DeviceInfo {
  id: string;
  type: 'daemon' | 'browser';
  name: string;
  createdAt: number;
}

export async function getDevice(token: string): Promise<DeviceInfo> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to fetch device info: HTTP ${res.status}`);
  }
  return (await res.json()) as DeviceInfo;
}

export async function unpairDevice(token: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/unpair`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to unpair device: HTTP ${res.status}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- api/devices`
Expected: PASS (all 6 tests)

Run: `npm run build -w @companion/web`
Expected: this will still fail at this point — `App.tsx`/`App.test.tsx` don't reference this file, so nothing here breaks the build, but do not treat a full `npm run build` failure elsewhere in the package as a failure of this task. Confirm instead that `packages/web/src/api/devices.ts` and `packages/web/src/api/devices.test.ts` type-check and test cleanly on their own, which the two commands above already showed.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/devices.ts packages/web/src/api/devices.test.ts
git commit -m "feat(web): add devices API client (getDevice, unpairDevice)"
```

---

### Task 4: Web — `SettingsScreen.tsx`

**Files:**
- Create: `packages/web/src/SettingsScreen.tsx`
- Test: `packages/web/src/SettingsScreen.test.tsx`

**Interfaces:**
- Consumes: `getDevice`, `unpairDevice`, `DeviceInfo` from `./api/devices` (Task 3); `UnauthorizedError` from `./api/sessions` (existing); `Link` from `react-router` (existing dependency, already used in `SessionList.tsx`).
- Produces: `SettingsScreen` default export with props `{ token: string; onUnpaired: () => void }` — consumed by Task 6's `App.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/SettingsScreen.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SettingsScreen from './SettingsScreen';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';

function renderSettings(token = 'tok-1', onUnpaired = vi.fn()) {
  render(
    <MemoryRouter>
      <SettingsScreen token={token} onUnpaired={onUnpaired} />
    </MemoryRouter>
  );
  return onUnpaired;
}

describe('SettingsScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the device's name, type, and paired-since date", async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: new Date('2026-01-15').getTime(),
    });

    renderSettings();

    expect(await screen.findByText('Chrome on Mac')).toBeInTheDocument();
    expect(screen.getByText('browser')).toBeInTheDocument();
    expect(screen.getByText(/paired/i)).toBeInTheDocument();
  });

  it('shows an inline error when loading device info fails', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockRejectedValue(new Error('HTTP 500'));

    renderSettings();

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });

  it('calls onUnpaired immediately if loading device info gets a 401', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockRejectedValue(new UnauthorizedError());

    const onUnpaired = renderSettings();

    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
  });

  it('requires confirmation before unpairing', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    const unpairDevice = vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);

    renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));

    expect(unpairDevice).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /confirm unpair/i })).toBeInTheDocument();
  });

  it('unpairs and calls onUnpaired after confirming', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);

    const onUnpaired = renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
  });

  it('cancelling the confirm step does not unpair', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    const unpairDevice = vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);

    renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.getByRole('button', { name: /unpair this device/i })).toBeInTheDocument();
    expect(unpairDevice).not.toHaveBeenCalled();
  });

  it('shows an inline error and does not call onUnpaired when the unpair request fails', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockRejectedValue(new Error('HTTP 500'));

    const onUnpaired = renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
    expect(onUnpaired).not.toHaveBeenCalled();
  });

  it('calls onUnpaired immediately if the unpair request gets a 401', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockRejectedValue(new UnauthorizedError());

    const onUnpaired = renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
  });

  it('has a link back to the session list', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });

    renderSettings();

    await screen.findByText('Chrome on Mac');
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute('href', '/');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- SettingsScreen`
Expected: FAIL — `./SettingsScreen` doesn't exist yet.

- [ ] **Step 3: Implement `SettingsScreen.tsx`**

Create `packages/web/src/SettingsScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getDevice, unpairDevice, type DeviceInfo } from './api/devices';
import { UnauthorizedError } from './api/sessions';

export interface SettingsScreenProps {
  token: string;
  onUnpaired: () => void;
}

export default function SettingsScreen({ token, onUnpaired }: SettingsScreenProps) {
  const [device, setDevice] = useState<DeviceInfo | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [unpairError, setUnpairError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const onUnpairedRef = useRef(onUnpaired);
  onUnpairedRef.current = onUnpaired;

  useEffect(() => {
    let cancelled = false;
    getDevice(token)
      .then((info) => {
        if (!cancelled) setDevice(info);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnpairedRef.current();
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleUnpair() {
    setBusy(true);
    setUnpairError(undefined);
    try {
      await unpairDevice(token);
      onUnpairedRef.current();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      setUnpairError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-6 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Link to="/" className="text-sm text-slate-400 underline">
          Back
        </Link>
      </div>

      {loadError && (
        <p role="alert" className="bg-red-900 text-red-100 rounded-md px-4 py-3">
          Couldn't load device info: {loadError}
        </p>
      )}

      {device && (
        <div className="bg-slate-800 rounded-md p-4 space-y-1">
          <p className="font-medium">{device.name}</p>
          <p className="text-sm text-slate-400 capitalize">{device.type}</p>
          <p className="text-sm text-slate-400">Paired {new Date(device.createdAt).toLocaleDateString()}</p>
        </div>
      )}

      <div className="border-t border-slate-700 pt-4 space-y-3">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="w-full rounded-md bg-red-700 px-3 py-2 font-medium"
          >
            Unpair this device
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-300">
              This will sign this device out and require a new pairing code to use it again. Continue?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleUnpair}
                disabled={busy}
                className="flex-1 rounded-md bg-red-700 px-3 py-2 font-medium disabled:opacity-50"
              >
                {busy ? 'Unpairing…' : 'Confirm unpair'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-md bg-slate-800 px-3 py-2 font-medium disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {unpairError && (
          <p role="alert" className="text-sm text-red-400">
            {unpairError}
          </p>
        )}
      </div>
    </div>
  );
}
```

The `onUnpairedRef` indirection exists because `onUnpaired` (passed from `App.tsx` as the shared `handleUnauthorized` callback) is a new function identity on every `App` render; putting it directly in the `useEffect` dependency array would re-run the `getDevice` fetch on every unrelated re-render. Capturing it in a ref that's updated every render, and reading `onUnpairedRef.current()` inside the effect/handler, means the effect only depends on `token` — matching the pattern already used for this exact problem in `SessionDetail.tsx`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- SettingsScreen`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/SettingsScreen.tsx packages/web/src/SettingsScreen.test.tsx
git commit -m "feat(web): add SettingsScreen with confirm-then-unpair flow"
```

---

### Task 5: Web — settings entry point in `SessionList`

**Files:**
- Modify: `packages/web/src/SessionList.tsx`
- Modify: `packages/web/src/SessionList.test.tsx`

**Interfaces:**
- Consumes: nothing new — routes to the literal path `/settings`, which Task 6 wires up in `App.tsx`. The two must agree on this exact string.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the failing test**

In `packages/web/src/SessionList.test.tsx`, the existing `'links each card to its session detail route'` test (currently using `screen.getByRole('link')`, which assumes there is exactly one link on the page) will break once a second link is added for Settings — `getByRole` throws if more than one match exists. Replace that test and add a new one for the Settings link. Find:

```tsx
  it('links each card to its session detail route', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/sessions/sess-a');
  });
```

Replace with:

```tsx
  it('links each card to its session detail route', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    const cardLink = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/sessions/sess-a');
    expect(cardLink).toBeDefined();
  });

  it('links to the settings screen', () => {
    mockSessions();
    renderList();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npm test -w @companion/web -- SessionList`
Expected: the new `'links to the settings screen'` test FAILS (no Settings link exists yet). The updated `'links each card...'` test PASSES even before Step 3's markup change — it only checks that a link to `/sessions/sess-a` exists among all links on the page, which is already true.

- [ ] **Step 3: Add the Settings link to the header**

In `packages/web/src/SessionList.tsx`, the header row currently reads (lines 32-38):

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-700' : 'bg-red-700'}`}>
          {connected ? 'live' : 'reconnecting…'}
        </span>
      </div>
```

Replace with:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-700' : 'bg-red-700'}`}>
            {connected ? 'live' : 'reconnecting…'}
          </span>
          <Link to="/settings" className="text-xs text-slate-400 underline">
            Settings
          </Link>
        </div>
      </div>
```

`Link` is already imported at the top of this file (`import { Link } from 'react-router';`), so no import changes are needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- SessionList`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/SessionList.tsx packages/web/src/SessionList.test.tsx
git commit -m "feat(web): add settings entry point to SessionList header"
```

---

### Task 6: Web — wire up `/settings` route in `App.tsx`

**Files:**
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`
- Modify: `packages/web/README.md`

**Interfaces:**
- Consumes: `SettingsScreen` from `./SettingsScreen` (Task 4), with props `{ token: string; onUnpaired: () => void }`. The route path `/settings` (Task 5).
- Produces: nothing consumed by other tasks — this is the final integration point.

- [ ] **Step 1: Write the failing test**

In `packages/web/src/App.test.tsx`, add `import * as devicesApi from './api/devices';` to the existing import block (after `import * as sessionsApi from './api/sessions';`), then add this test at the end of the `describe('App', ...)` block, after the existing `'redirects an unknown path to the session list'` test:

```tsx
  it('shows the settings screen at /settings and returns to the pairing screen after a confirmed unpair', async () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Test Browser',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);
    window.history.pushState({}, '', '/settings');

    render(<App />);

    await screen.findByText('Test Browser');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    expect(await screen.findByText('Pair this device')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npm test -w @companion/web -- App.test`
Expected: FAIL — there is no `/settings` route yet, so `screen.findByText('Test Browser')` times out.

- [ ] **Step 3: Wire up the route**

Replace the full contents of `packages/web/src/App.tsx` with:

```tsx
import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router';
import PairingScreen from './PairingScreen';
import SessionList from './SessionList';
import SessionDetail from './SessionDetail';
import SettingsScreen from './SettingsScreen';
import { SessionsProvider } from './SessionsProvider';
import { clearStoredCredentials, getStoredCredentials } from './storage';

// React Router reuses the same SessionDetail instance across an id-only
// navigation (/sessions/A -> /sessions/B), which would let stale
// events/lastSeq/historyLoaded state from the old session persist for a
// moment after `summary` (read fresh from context) has already flipped to
// the new one. Keying on `id` forces a remount on every id change.
function KeyedSessionDetail(props: { token: string; onUnauthorized: () => void }) {
  const { id } = useParams<{ id: string }>();
  return <SessionDetail key={id} {...props} />;
}

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
            element={<KeyedSessionDetail token={credentials.token} onUnauthorized={handleUnauthorized} />}
          />
          <Route
            path="/settings"
            element={<SettingsScreen token={credentials.token} onUnpaired={handleUnauthorized} />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionsProvider>
  );
}
```

The `/settings` route reuses `handleUnauthorized` as `SettingsScreen`'s `onUnpaired` prop: both a rejected token and a confirmed unpair end in the identical state transition (clear stored credentials, show `PairingScreen`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- App.test`
Expected: PASS (all 5 tests, including the new one)

- [ ] **Step 5: Run the full web test suite and build**

Run: `npm test -w @companion/web`
Expected: PASS — all tests across the package, including Tasks 3, 4, 5's new/modified files.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors.

- [ ] **Step 6: Update the web README**

In `packages/web/README.md`, the `## Views` section currently reads (lines 25-41):

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
```

Replace with:

```markdown
## Views

Three client-side routes (`react-router`), all behind the pairing gate in
`App.tsx`:

- `/` — `SessionList`: every one of the user's active sessions (including
  stopped-but-not-yet-dismissed ones), sorted with anything waiting on a
  permission decision first, then by most recent activity.
- `/sessions/:id` — `SessionDetail`: the full live view of one session
  (activity feed, modified files, permission prompt, controls) — this is
  what `Dashboard` used to be before multi-session support.
- `/settings` — `SettingsScreen`: this device's paired info (name, type,
  paired date) and an "Unpair this device" action behind a confirm step.
  Unpairing calls the relay to revoke the device's token server-side and
  force-close any other live tab using it, then clears local storage and
  returns to the pairing screen — there is no separate "logout" distinct
  from unpairing, since the device token is the only credential this app
  has.

`SessionList` and `SessionDetail` share a single WebSocket connection,
owned by `SessionsProvider` (`src/SessionsProvider.tsx` +
`src/use-sessions-store.ts`) above the router: the relay broadcasts every
event for every one of a user's sessions to every one of their browser
connections unscoped, so both views read off the same stream rather than
opening their own. `SettingsScreen` doesn't need this stream — it talks to
the relay directly over REST (`src/api/devices.ts`).
```

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/App.tsx packages/web/src/App.test.tsx packages/web/README.md
git commit -m "feat(web): wire up /settings route in App"
```

---

## Final Verification

After all 6 tasks are complete:

Run: `npm test` from the repo root (`D:/Companion`)
Expected: PASS across all four packages (`@companion/daemon`, `@companion/protocol`, `@companion/relay`, `@companion/web`).

Run: `npm run build` from the repo root
Expected: PASS with no type errors, `@companion/web`'s Vite build succeeds with PWA artifacts generated.
