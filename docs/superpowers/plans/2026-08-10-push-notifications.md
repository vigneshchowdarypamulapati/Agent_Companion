# Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Web Push notification to every one of a user's paired browsers when a session hits `permission_request`, `error`, or `stopped`, with an enable/disable toggle in the already-built `SettingsScreen`.

**Architecture:** The relay gains a `PushSender` port (mirroring the existing `Store`/`PubSub` port pattern) triggered from `ConnectionHub.routeFromDaemon` — not `dispatchLocal` — so exactly one push fires per event regardless of how many relay instances a future deployment scales out to. A push subscription lives as an optional field directly on the existing `Device` record. The web PWA switches its service worker from Workbox's `generateSW` to `injectManifest` mode with a custom `src/sw.ts`, the only way to add a custom `push` event listener; that same file re-implements the SPA navigation fallback the old `generateSW` config provided, so direct navigation to `/sessions/:id` or `/settings` still works.

**Tech Stack:** TypeScript, Zod (protocol schemas), Express (relay), the `web-push` npm package (VAPID-authenticated Web Push), React 19 (web), Workbox 7 (`workbox-precaching` + `workbox-routing`) for the custom service worker, Vitest.

## Global Constraints

- `ConnectionHub`'s constructor gains exactly one new optional parameter, `pushSender`, appended after the existing `graceMs`/`now` parameters; all existing call sites (`new ConnectionHub(store, pubsub)`) keep working unchanged.
- The push-notification trigger lives in `routeFromDaemon`, never in `dispatchLocal` — this is a correctness requirement (see Architecture above), not a style preference.
- Push notifications are entirely optional infrastructure: with no VAPID env vars configured, the relay starts and runs exactly as it does today, and the web Settings screen's notifications section simply doesn't render.
- Notification title strings are exact literals: `"Needs your permission"` for `permission_request`, `"Session error"` for `error`, `"Session stopped"` for `stopped`.
- New dependencies are expected and in-scope for this feature specifically (`web-push` + `@types/web-push` for the relay; `workbox-precaching` + `workbox-routing` for the web package's custom service worker) — this is the one place in this project where adding a dependency is the point, not a shortcut.
- Follows the existing Tailwind dark-theme + inline-conditional-render UX patterns already used throughout `SettingsScreen.tsx` — no new UI dependencies beyond what the service worker itself needs.
- `POST`/`DELETE /devices/push-subscription` act only on the calling device — no device-id parameter, same self-only scoping already established by the unpair endpoints.

---

### Task 1: Protocol — `PushSubscriptionPayload` schema

**Files:**
- Create: `packages/protocol/src/push.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/push.test.ts`

**Interfaces:**
- Produces: `PushSubscriptionPayload` — a Zod schema and its inferred type, `{ endpoint: string; keys: { p256dh: string; auth: string } }`. Consumed by Tasks 2, 3, 5, 6.

- [ ] **Step 1: Write the failing test**

Create `packages/protocol/src/push.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PushSubscriptionPayload } from './push.js';

describe('PushSubscriptionPayload schema', () => {
  it('accepts a valid push subscription', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://push.example.com/abc123',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a subscription missing keys', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://push.example.com/abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a subscription missing the auth key', () => {
    const result = PushSubscriptionPayload.safeParse({
      endpoint: 'https://push.example.com/abc123',
      keys: { p256dh: 'key-p256dh' },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @companion/protocol -- push.test`
Expected: FAIL — `./push.js` doesn't exist yet.

- [ ] **Step 3: Implement the schema**

Create `packages/protocol/src/push.ts`:

```ts
import { z } from 'zod';

export const PushSubscriptionPayload = z.object({
  endpoint: z.string(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});
export type PushSubscriptionPayload = z.infer<typeof PushSubscriptionPayload>;
```

Add it to `packages/protocol/src/index.ts`, which currently reads:

```ts
export * from './events.js';
export * from './commands.js';
export * from './relay.js';
```

Replace with:

```ts
export * from './events.js';
export * from './commands.js';
export * from './relay.js';
export * from './push.js';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @companion/protocol -- push.test`
Expected: PASS (all 3 tests)

Run: `npm run build -w @companion/protocol`
Expected: PASS with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/push.ts packages/protocol/src/push.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add PushSubscriptionPayload schema"
```

---

### Task 2: Relay — `Device.pushSubscription`, `Store.setPushSubscription`, `Store.getDevicesForUser`

**Files:**
- Modify: `packages/relay/src/store.ts`
- Modify: `packages/relay/src/in-memory-store.ts`
- Modify: `packages/relay/src/in-memory-store.test.ts`

**Interfaces:**
- Consumes: `PushSubscriptionPayload` from `@companion/protocol` (Task 1).
- Produces: `Device.pushSubscription?: PushSubscriptionPayload`. `Store.setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void>` — idempotent, no-op if the device doesn't exist. `Store.getDevicesForUser(userId: string): Promise<Device[]>`. Consumed by Tasks 4 and 5.

- [ ] **Step 1: Write the failing tests**

Add these four tests to `packages/relay/src/in-memory-store.test.ts`, right after the existing `'deleteDevice is a no-op for an unknown device id'` test:

```ts

  it('setPushSubscription stores a subscription on the device', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const device = await store.createDevice({
      userId: user.id,
      type: 'browser',
      name: 'phone',
      tokenHash: 'hash-3',
    });
    const subscription = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };

    await store.setPushSubscription(device.id, subscription);

    const devices = await store.getDevicesForUser(user.id);
    expect(devices.find((d) => d.id === device.id)?.pushSubscription).toEqual(subscription);
  });

  it('setPushSubscription with undefined clears an existing subscription', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const device = await store.createDevice({
      userId: user.id,
      type: 'browser',
      name: 'phone',
      tokenHash: 'hash-4',
    });
    await store.setPushSubscription(device.id, {
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: 'p', auth: 'a' },
    });

    await store.setPushSubscription(device.id, undefined);

    const devices = await store.getDevicesForUser(user.id);
    expect(devices.find((d) => d.id === device.id)?.pushSubscription).toBeUndefined();
  });

  it('setPushSubscription is a no-op for an unknown device id', async () => {
    const store = new InMemoryStore();
    await expect(
      store.setPushSubscription('does-not-exist', { endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } })
    ).resolves.toBeUndefined();
  });

  it('getDevicesForUser returns only devices belonging to that user', async () => {
    const store = new InMemoryStore();
    await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-5' });
    await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-6' });
    await store.createDevice({ userId: 'user-2', type: 'browser', name: 'intruder', tokenHash: 'hash-7' });

    const devices = await store.getDevicesForUser('user-1');

    expect(devices.map((d) => d.name).sort()).toEqual(['laptop', 'phone']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- in-memory-store`
Expected: FAIL — `setPushSubscription`/`getDevicesForUser` are not functions.

- [ ] **Step 3: Add the field and methods**

In `packages/relay/src/store.ts`, the top of the file currently reads:

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
```

Replace with:

```ts
import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';

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
  pushSubscription?: PushSubscriptionPayload;
}
```

The `Store` interface currently reads:

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

Add `setPushSubscription` and `getDevicesForUser`:

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
  setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void>;
  getDevicesForUser(userId: string): Promise<Device[]>;
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

- [ ] **Step 4: Implement both methods in `InMemoryStore`**

In `packages/relay/src/in-memory-store.ts`, the top of the file currently reads:

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
```

Replace with:

```ts
import { randomInt, randomUUID } from 'node:crypto';
import type { PushSubscriptionPayload, SessionEvent, SessionStatus } from '@companion/protocol';
import type {
  Device,
  DismissSessionResult,
  PairingCode,
  SessionRecord,
  Store,
  StoredSessionEvent,
  User,
} from './store.js';
```

Add these two methods right after `deleteDevice` (before `createPairingCode`):

```ts
  async setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.pushSubscription = subscription;
  }

  async getDevicesForUser(userId: string): Promise<Device[]> {
    return [...this.devices.values()].filter((d) => d.userId === userId);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- in-memory-store`
Expected: PASS (all tests in the file, including the 4 new ones)

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/store.ts packages/relay/src/in-memory-store.ts packages/relay/src/in-memory-store.test.ts
git commit -m "feat(relay): add push subscription storage to Store/InMemoryStore"
```

---

### Task 3: Relay — `PushSender` port and `WebPushSender`

**Files:**
- Create: `packages/relay/src/push-sender.ts`
- Create: `packages/relay/src/web-push-sender.ts`
- Test: `packages/relay/src/web-push-sender.test.ts`
- Modify: `packages/relay/package.json`

**Interfaces:**
- Consumes: `PushSubscriptionPayload` from `@companion/protocol` (Task 1).
- Produces: `PushPayload { title: string; body: string; url: string }`. `PushSendResult = 'ok' | 'gone'`. `PushSender` interface with `send(subscription, payload): Promise<PushSendResult>`. `WebPushSender implements PushSender`, constructed with `{ vapidPublicKey, vapidPrivateKey, vapidSubject }`. Consumed by Tasks 4 and 5.

- [ ] **Step 1: Add the `web-push` dependency**

In `packages/relay/package.json`, the `dependencies` and `devDependencies` blocks currently read:

```json
  "dependencies": {
    "@companion/protocol": "*",
    "express": "^4.21.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^7.0.2",
    "vitest": "^4.1.10",
    "supertest": "^7.2.2",
    "@types/express": "^4.17.25",
    "@types/supertest": "^6.0.3",
    "@types/node": "^22.20.1",
    "@types/ws": "^8.18.1"
  }
```

Replace with:

```json
  "dependencies": {
    "@companion/protocol": "*",
    "express": "^4.21.0",
    "web-push": "^3.6.7",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^7.0.2",
    "vitest": "^4.1.10",
    "supertest": "^7.2.2",
    "@types/express": "^4.17.25",
    "@types/supertest": "^6.0.3",
    "@types/node": "^22.20.1",
    "@types/web-push": "^3.6.4",
    "@types/ws": "^8.18.1"
  }
```

Run: `npm install` from the repo root (`D:/Companion`) to update the lockfile.

- [ ] **Step 2: Write the failing tests**

Create `packages/relay/src/web-push-sender.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import webpush from 'web-push';
import { WebPushSender } from './web-push-sender.js';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

const subscription = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
const options = { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', vapidSubject: 'mailto:you@example.com' };

describe('WebPushSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures VAPID details on construction', () => {
    new WebPushSender(options);

    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:you@example.com', 'pub', 'priv');
  });

  it('sends a notification and returns ok on success', async () => {
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);
    const sender = new WebPushSender(options);

    const result = await sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' });

    expect(result).toBe('ok');
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify({ title: 'Hi', body: 'There', url: '/sessions/sess-1' })
    );
  });

  it('returns gone on a 404 from the push service', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 404 });
    const sender = new WebPushSender(options);

    expect(await sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' })).toBe('gone');
  });

  it('returns gone on a 410 from the push service', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 410 });
    const sender = new WebPushSender(options);

    expect(await sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' })).toBe('gone');
  });

  it('rethrows any other error', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 500, message: 'server error' });
    const sender = new WebPushSender(options);

    await expect(
      sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' })
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- web-push-sender`
Expected: FAIL — `./web-push-sender.js` doesn't exist yet.

- [ ] **Step 4: Implement `push-sender.ts` and `web-push-sender.ts`**

Create `packages/relay/src/push-sender.ts`:

```ts
import type { PushSubscriptionPayload } from '@companion/protocol';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export type PushSendResult = 'ok' | 'gone';

export interface PushSender {
  send(subscription: PushSubscriptionPayload, payload: PushPayload): Promise<PushSendResult>;
}
```

Create `packages/relay/src/web-push-sender.ts`:

```ts
import webpush from 'web-push';
import type { PushSubscriptionPayload } from '@companion/protocol';
import type { PushPayload, PushSendResult, PushSender } from './push-sender.js';

export interface WebPushSenderOptions {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

export class WebPushSender implements PushSender {
  constructor(options: WebPushSenderOptions) {
    webpush.setVapidDetails(options.vapidSubject, options.vapidPublicKey, options.vapidPrivateKey);
  }

  async send(subscription: PushSubscriptionPayload, payload: PushPayload): Promise<PushSendResult> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload)
      );
      return 'ok';
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        return 'gone';
      }
      throw err;
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- web-push-sender`
Expected: PASS (all 5 tests)

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/package.json package-lock.json packages/relay/src/push-sender.ts packages/relay/src/web-push-sender.ts packages/relay/src/web-push-sender.test.ts
git commit -m "feat(relay): add PushSender port and WebPushSender implementation"
```

---

### Task 4: Relay — `ConnectionHub` push notification trigger

**Files:**
- Modify: `packages/relay/src/hub.ts`
- Modify: `packages/relay/src/hub.test.ts`

**Interfaces:**
- Consumes: `Store.getDevicesForUser`, `Store.setPushSubscription` (Task 2); `PushSender`, `PushPayload` (Task 3).
- Produces: `ConnectionHub`'s constructor gains a 5th, optional parameter, `pushSender?: PushSender` — existing call sites (`new ConnectionHub(store, pubsub)`, `new ConnectionHub(store, pubsub, graceMs)`) keep working unchanged. Consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

`packages/relay/src/hub.test.ts`'s imports currently read:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectionHub, type Connection, type RelayHubMessage } from './hub.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
```

Replace with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectionHub, type Connection, type RelayHubMessage } from './hub.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import type { PushPayload, PushSendResult, PushSender } from './push-sender.js';
import type { PushSubscriptionPayload } from '@companion/protocol';
```

Add this fake push sender factory right after the existing `fakeConnection` function (before `startedHub`):

```ts

function fakePushSender(result: PushSendResult | 'throw' = 'ok'): PushSender & {
  sent: { subscription: PushSubscriptionPayload; payload: PushPayload }[];
} {
  const sent: { subscription: PushSubscriptionPayload; payload: PushPayload }[] = [];
  return {
    sent,
    send: async (subscription, payload) => {
      sent.push({ subscription, payload });
      if (result === 'throw') throw new Error('push service unavailable');
      return result;
    },
  };
}
```

Then add these ten tests at the end of the file, immediately before the final closing `});` of the `describe('ConnectionHub', ...)` block (i.e. right after the existing `"force-closing a daemon's connection via disconnectDevice still triggers the grace-period stop"` test):

```ts

  // --- push notifications ---

  const subscriptionA = { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p-a', auth: 'a-a' } };
  const subscriptionB = { endpoint: 'https://push.example.com/b', keys: { p256dh: 'p-b', auth: 'a-b' } };

  it('sends a push notification to a subscribed browser device on a permission_request event', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const browserDevice = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'permission_request',
      sessionId: 'sess-1',
      requestId: 'req-1',
      toolName: 'Bash',
      input: {},
      at: 2,
    });

    expect(pushSender.sent).toHaveLength(1);
    expect(pushSender.sent[0]).toMatchObject({
      subscription: subscriptionA,
      payload: { title: 'Needs your permission', body: '/tmp/project', url: '/sessions/sess-1' },
    });
  });

  it('sends a push notification on error and stopped events', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const browserDevice = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'error', sessionId: 'sess-1', message: 'boom', at: 2 });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 3 });

    expect(pushSender.sent.map((s) => s.payload.title)).toEqual(['Session error', 'Session stopped']);
  });

  it('does not send a push notification for a non-qualifying event type', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const browserDevice = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent).toHaveLength(0);
  });

  it('does not send a push notification to a browser device with no subscription', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent).toHaveLength(0);
  });

  it('sends a push notification to every subscribed browser device for the user', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const deviceA = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    const deviceB = await store.createDevice({
      userId: user.id,
      type: 'browser',
      name: 'laptop-browser',
      tokenHash: 'h2',
    });
    await store.setPushSubscription(deviceA.id, subscriptionA);
    await store.setPushSubscription(deviceB.id, subscriptionB);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent.map((s) => s.subscription)).toEqual(expect.arrayContaining([subscriptionA, subscriptionB]));
    expect(pushSender.sent).toHaveLength(2);
  });

  it('does not send a push notification to the daemon device itself', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const daemonDevice = await store.createDevice({ userId: user.id, type: 'daemon', name: 'laptop', tokenHash: 'h1' });
    // A daemon device could in principle have a pushSubscription field set (nothing in the
    // Store forbids it); the hub must still never target daemon-typed devices.
    await store.setPushSubscription(daemonDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent).toHaveLength(0);
  });

  it("clears a device's subscription when the push sender reports it is gone", async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender('gone');
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const browserDevice = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    const devices = await store.getDevicesForUser(user.id);
    expect(devices.find((d) => d.id === browserDevice.id)?.pushSubscription).toBeUndefined();
  });

  it("one device's push failure does not prevent another device's push from being sent", async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender('throw');
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const user = await store.getOrCreateDefaultUser();
    const deviceA = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    const deviceB = await store.createDevice({
      userId: user.id,
      type: 'browser',
      name: 'laptop-browser',
      tokenHash: 'h2',
    });
    await store.setPushSubscription(deviceA.id, subscriptionA);
    await store.setPushSubscription(deviceB.id, subscriptionB);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 })
    ).resolves.toBeUndefined();

    // Both sends were attempted despite both throwing — routeFromDaemon itself never rejects.
    expect(pushSender.sent).toHaveLength(2);
  });

  it('does not attempt to send a push notification when no pushSender is configured', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const user = await store.getOrCreateDefaultUser();
    const browserDevice = await store.createDevice({ userId: user.id, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 })
    ).resolves.toBeUndefined();
  });

  it("a daemon disconnect's grace-period stop also sends a push notification", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pushSender = fakePushSender();
      const hub = new ConnectionHub(store, new InMemoryPubSub(), 1000, undefined, pushSender);
      await hub.start();
      const user = await store.getOrCreateDefaultUser();
      const browserDevice = await store.createDevice({
        userId: user.id,
        type: 'browser',
        name: 'phone',
        tokenHash: 'h1',
      });
      await store.setPushSubscription(browserDevice.id, subscriptionA);
      const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: user.id });
      hub.register(daemon);

      await hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project',
        at: 1,
      });

      hub.unregister(daemon);
      await vi.advanceTimersByTimeAsync(1000);

      expect(pushSender.sent).toHaveLength(1);
      expect(pushSender.sent[0].payload.title).toBe('Session stopped');
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- hub.test`
Expected: FAIL — `pushSender` isn't a valid 5th constructor argument yet, and none of the notification behavior exists.

- [ ] **Step 3: Wire push notifications into `ConnectionHub`**

Replace the full contents of `packages/relay/src/hub.ts` with:

```ts
import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
import type { Store } from './store.js';
import type { PubSub } from './pubsub.js';
import type { PushPayload, PushSender } from './push-sender.js';

export interface Connection {
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceType: 'daemon' | 'browser';
  send(message: RelayHubMessage): void;
  close(): void;
}

export type RelayHubMessage =
  | { kind: 'event'; sessionId: string; seq: number; event: SessionEvent }
  | { kind: 'command'; sessionId: string; command: Command };

interface PubSubEnvelope {
  userId: string;
  targetDeviceId?: string;
  message: RelayHubMessage;
}

const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  turn_complete: 'running',
  stopped: 'stopped',
  error: 'stopped',
};

/**
 * Event types that trigger a push notification, and the notification title for each. A type
 * absent from this map never notifies — this is the single source of truth for "which events
 * are worth waking someone's phone up for" (currently: a permission prompt blocking the
 * session, an error, or the session stopping).
 */
const NOTIFICATION_TITLE_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], string>> = {
  permission_request: 'Needs your permission',
  error: 'Session error',
  stopped: 'Session stopped',
};

const CHANNEL = 'relay:message';

/** How long a daemon's sessions stay non-stopped after its last connection drops, before being
 * treated as orphaned. Long enough that a brief network blip or process restart doesn't falsely
 * kill an in-progress session; short enough that a genuinely dead daemon's sessions become
 * dismissable in a reasonable time. */
const DEFAULT_DAEMON_DISCONNECT_GRACE_MS = 30_000;

export class ConnectionHub {
  /**
   * Connections are keyed by deviceId but stored as a Set, because the same device may hold
   * several simultaneous connections (two browser tabs sharing a token, or a reconnect whose
   * predecessor's `close` event has not fired yet). Unregistering is identity-based so a stale
   * socket's late `close` cannot evict a live one.
   */
  private connections = new Map<string, Set<Connection>>();

  /** Pending grace-period timers, keyed by daemon deviceId. Cancelled by a reconnect (see
   * `register`) before they fire; fires in `stopDaemonSessions` otherwise. */
  private pendingDaemonStops = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private store: Store,
    private pubsub: PubSub,
    private graceMs: number = DEFAULT_DAEMON_DISCONNECT_GRACE_MS,
    private now: () => number = Date.now,
    private pushSender?: PushSender
  ) {}

  /** Must be awaited before the hub will receive any routed messages. */
  async start(): Promise<void> {
    await this.pubsub.subscribe(CHANNEL, (message) => this.dispatchLocal(message as PubSubEnvelope));
  }

  register(connection: Connection): void {
    const set = this.connections.get(connection.deviceId) ?? new Set<Connection>();
    set.add(connection);
    this.connections.set(connection.deviceId, set);

    if (connection.deviceType === 'daemon') {
      const pending = this.pendingDaemonStops.get(connection.deviceId);
      if (pending) {
        clearTimeout(pending);
        this.pendingDaemonStops.delete(connection.deviceId);
      }
    }
  }

  unregister(connection: Connection): void {
    const set = this.connections.get(connection.deviceId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.connections.delete(connection.deviceId);
      if (connection.deviceType === 'daemon') {
        this.scheduleDaemonStop(connection.deviceId, connection.userId);
      }
    }
  }

  /**
   * Force-closes every live connection currently authenticated as `deviceId`, and removes
   * them from the hub immediately rather than waiting for the transport's own close handling
   * to get around to it. `ws.close()` performs a graceful close handshake with up to a 30s
   * timeout before the socket is actually destroyed — without an immediate `unregister()`
   * here, a revoked device could keep receiving live session events for up to 30s after
   * "revocation." Calling `unregister()` here is safe even though the WebSocket 'close'
   * handler in server.ts also calls it once the socket actually closes: `unregister()`
   * no-ops if the connection is already gone from its deviceId's set, so that later call is
   * a harmless no-op. (Mutating the Set via `unregister` while iterating it here is also
   * safe — deleting the current element during a for-of over a Set does not skip or revisit
   * any other element.)
   */
  disconnectDevice(deviceId: string): void {
    const set = this.connections.get(deviceId);
    if (!set) return;
    for (const connection of set) {
      connection.close();
      this.unregister(connection);
    }
  }

  private scheduleDaemonStop(deviceId: string, userId: string): void {
    const timer = setTimeout(() => {
      this.pendingDaemonStops.delete(deviceId);
      void this.stopDaemonSessions(deviceId, userId);
    }, this.graceMs);
    this.pendingDaemonStops.set(deviceId, timer);
  }

  /**
   * Marks every non-stopped session owned by a now-fully-disconnected daemon as stopped, the same
   * way a genuine `stopped` event from that daemon would be handled: store status updated, event
   * appended to the session's log, broadcast live to the user's browsers with a store-assigned
   * seq, AND a push notification sent the same way a genuine `stopped` event routed through
   * routeFromDaemon would — a crashed daemon is exactly the kind of unexpected stop worth
   * notifying about. Runs `graceMs` after the daemon's last connection closes; cancelled by a
   * reconnect within that window (see `register`).
   */
  private async stopDaemonSessions(deviceId: string, userId: string): Promise<void> {
    try {
      const sessions = await this.store.getActiveSessionsForUser(userId);
      const orphaned = sessions.filter((s) => s.daemonDeviceId === deviceId && s.status !== 'stopped');
      for (const session of orphaned) {
        const event: SessionEvent = { type: 'stopped', sessionId: session.id, at: this.now() };
        await this.store.updateSessionStatus(session.id, 'stopped');
        const stored = await this.store.appendSessionEvent(session.id, event);
        await this.pubsub.publish(CHANNEL, {
          userId,
          message: { kind: 'event', sessionId: session.id, seq: stored.seq, event },
        } satisfies PubSubEnvelope);
        await this.notifyPush(userId, session.id, event.type);
      }
    } catch {
      // Best-effort cleanup running detached from any request/connection — a store or pubsub
      // failure here must not crash the relay process.
    }
  }

  private allConnections(): Connection[] {
    return [...this.connections.values()].flatMap((set) => [...set]);
  }

  async routeFromDaemon(connection: Connection, sessionId: string, event: SessionEvent): Promise<void> {
    if (event.sessionId !== sessionId) {
      throw new Error('Envelope sessionId does not match event payload sessionId');
    }

    if (event.type === 'session_started') {
      const existing = await this.store.getSession(sessionId);
      if (existing && existing.daemonDeviceId !== connection.deviceId) {
        throw new Error(`Session ${sessionId} is already owned by a different daemon`);
      }
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
    } else {
      // Verify ownership for non-session_started events
      const session = await this.store.getSession(sessionId);
      if (!session || session.daemonDeviceId !== connection.deviceId) {
        throw new Error(`Unknown session ${sessionId}`);
      }
      const status = STATUS_BY_EVENT_TYPE[event.type];
      if (status) {
        await this.store.updateSessionStatus(sessionId, status);
      }
    }

    const stored = await this.store.appendSessionEvent(sessionId, event);
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      message: { kind: 'event', sessionId, seq: stored.seq, event },
    } satisfies PubSubEnvelope);

    await this.notifyPush(connection.userId, sessionId, event.type);
  }

  async routeFromBrowser(connection: Connection, sessionId: string, command: Command): Promise<void> {
    if (command.type === 'start_session') {
      throw new Error('start_session cannot be routed through the relay');
    }
    if (command.sessionId !== sessionId) {
      throw new Error('Envelope sessionId does not match command payload sessionId');
    }
    const session = await this.store.getSession(sessionId);
    if (!session || session.userId !== connection.userId) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      targetDeviceId: session.daemonDeviceId,
      message: { kind: 'command', sessionId, command },
    } satisfies PubSubEnvelope);
  }

  /**
   * Sends a push notification to every one of `userId`'s browser devices that has a stored
   * push subscription, for a qualifying event type (see NOTIFICATION_TITLE_BY_EVENT_TYPE).
   * Deliberately called from routeFromDaemon and stopDaemonSessions (each runs once per event,
   * on whichever relay instance actually processed it) rather than from dispatchLocal (runs
   * once per relay instance subscribed to the pubsub channel) — sending from dispatchLocal
   * would fire a duplicate push per relay instance in a horizontally-scaled deployment. Every
   * failure mode here — no matching title, no session, an individual device's send failing, a
   * store failure — is swallowed: push delivery is best-effort and must never affect event
   * routing or crash the process.
   */
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
      await Promise.all(
        targets.map(async (device) => {
          try {
            const result = await this.pushSender!.send(device.pushSubscription!, payload);
            if (result === 'gone') {
              await this.store.setPushSubscription(device.id, undefined);
            }
          } catch {
            // A single device's push failure must not affect other devices or the caller.
          }
        })
      );
    } catch {
      // Push notification delivery is best-effort and must never affect event routing.
    }
  }

  private dispatchLocal(envelope: PubSubEnvelope): void {
    if (envelope.message.kind === 'event') {
      for (const connection of this.allConnections()) {
        if (connection.userId === envelope.userId && connection.deviceType === 'browser') {
          connection.send(envelope.message);
        }
      }
    } else {
      const targets = envelope.targetDeviceId ? this.connections.get(envelope.targetDeviceId) : undefined;
      for (const target of targets ?? []) {
        if (target.userId === envelope.userId) {
          target.send(envelope.message);
        }
      }
    }
  }
}
```

Note the addition inside `stopDaemonSessions`: `await this.notifyPush(userId, session.id, event.type);`. The spec's data-flow diagram only shows the trigger inside `routeFromDaemon`, but a crashed daemon's sessions reaching `stopped` via this grace-period path is exactly the kind of unexpected stop the `stopped` event type was chosen to cover — without this line, a user would never be notified when their session died because the daemon itself crashed, only when it stopped cleanly. This is a deliberate, necessary extension of the spec's literal text, not a deviation from its intent.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- hub.test`
Expected: PASS (all tests in the file, including the 10 new ones)

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors. `pushSender` is a new optional 5th constructor parameter, so `server.ts`'s existing `new ConnectionHub(store, pubsub)` 2-argument call site (not yet touched by this task) remains valid TypeScript — there is no interim build gap here, unlike a required-member addition would cause.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/hub.ts packages/relay/src/hub.test.ts
git commit -m "feat(relay): trigger push notifications from ConnectionHub.routeFromDaemon"
```

---

### Task 5: Relay — `server.ts` push routes, `main.ts` VAPID wiring, relay README

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`
- Modify: `packages/relay/src/main.ts`
- Modify: `packages/relay/README.md`

**Interfaces:**
- Consumes: `Store.setPushSubscription` (Task 2); `PushSender`, `WebPushSender` (Task 3); `ConnectionHub`'s new 5th constructor parameter (Task 4); `PushSubscriptionPayload` from `@companion/protocol` (Task 1).
- Produces: `GET /push/vapid-public-key` → `200 { publicKey }` or `404`. `POST /devices/push-subscription` → `200 { ok: true }`, `401`, or `400`. `DELETE /devices/push-subscription` → `200 { ok: true }` or `401`. `RelayServerOptions` gains optional `pushSender?: PushSender` and `vapidPublicKey?: string`.

- [ ] **Step 1: Write the failing tests**

`packages/relay/src/server.test.ts`'s imports currently read:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
```

Replace with:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import type { PushSender } from './push-sender.js';
```

Add these seven tests right before the final closing `});` of the `describe('relay server', ...)` block, right after the existing `'force-closes every other live connection authenticated as the unpaired device'` test:

```ts

  // --- push notifications ---

  it('returns 404 for GET /push/vapid-public-key when push is not configured', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(404);
  });

  it('returns the configured VAPID public key', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      vapidPublicKey: 'test-public-key',
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: 'test-public-key' });
  });

  it('returns 401 for POST /devices/push-subscription without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/devices/push-subscription')
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(401);
  });

  it('returns 400 for POST /devices/push-subscription with an invalid subscription body', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer)
      .post('/devices/push-subscription')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://push.example.com/x' });
    expect(res.status).toBe(400);
  });

  it('a stored push subscription receives a notification when a qualifying event fires', async () => {
    const store = new InMemoryStore();
    const sent: unknown[] = [];
    const pushSender: PushSender = {
      send: async (subscription, payload) => {
        sent.push({ subscription, payload });
        return 'ok';
      },
    };
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), pushSender });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const subscribeRes = await request(httpServer)
      .post('/devices/push-subscription')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(subscribeRes.status).toBe(200);

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
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'stopped', sessionId: 'sess-1', at: Date.now() },
      })
    );

    await expect.poll(() => sent.length, { timeout: 2000 }).toBe(1);
    expect(sent[0]).toMatchObject({ payload: { title: 'Session stopped', body: '/tmp/project' } });
  });

  it('clears the subscription after DELETE /devices/push-subscription', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    await request(httpServer)
      .post('/devices/push-subscription')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });

    const deleteRes = await request(httpServer)
      .delete('/devices/push-subscription')
      .set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });
  });

  it('returns 401 for DELETE /devices/push-subscription without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).delete('/devices/push-subscription');
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- server.test`
Expected: FAIL — none of the three new routes exist yet (404s where 200/401/400 are expected).

- [ ] **Step 3: Add the routes and wire `pushSender`/`vapidPublicKey` through**

Replace the full contents of `packages/relay/src/server.ts` with:

```ts
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { RelayMessage, RedeemPairingRequest, PushSubscriptionPayload } from '@companion/protocol';
import type { Device, Store } from './store.js';
import type { PubSub } from './pubsub.js';
import { PairingService } from './pairing.js';
import { ConnectionHub, type Connection } from './hub.js';
import type { PushSender } from './push-sender.js';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/**
 * Extracts a device token from the `Authorization: Bearer <token>` header and verifies it.
 * REST callers can set headers, so unlike the WS handshake they do not use query-param auth.
 */
async function authenticate(req: Request, pairing: PairingService): Promise<Device | undefined> {
  const header = req.header('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return undefined;
  return pairing.verifyToken(token);
}

export interface RelayServerOptions {
  store: Store;
  pubsub: PubSub;
  pushSender?: PushSender;
  vapidPublicKey?: string;
}

export async function createRelayServer({ store, pubsub, pushSender, vapidPublicKey }: RelayServerOptions): Promise<Server> {
  const pairing = new PairingService(store);
  const hub = new ConnectionHub(store, pubsub, undefined, undefined, pushSender);
  await hub.start();

  const app = express();
  app.use(express.json());

  app.post(
    '/pairing/request-code',
    asyncHandler(async (_req, res) => {
      const result = await pairing.requestPairingCode();
      res.status(201).json(result);
    })
  );

  app.post(
    '/pairing/redeem',
    asyncHandler(async (req, res) => {
      const { code, deviceType, deviceName } = RedeemPairingRequest.parse(req.body);
      const result = await pairing.redeemPairingCode(code, deviceType, deviceName);
      if (!result) {
        res.status(400).json({ error: 'Invalid or expired pairing code' });
        return;
      }
      res.status(201).json({ token: result.token, deviceId: result.device.id });
    })
  );

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

  app.get(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const session = await store.getSession(req.params.id);
      // Same response whether the session is missing or owned by someone else, so a
      // non-owner cannot enumerate session ids.
      if (!session || session.userId !== device.userId) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      res.status(200).json(session);
    })
  );

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
      await store.deleteDevice(device.id);
      hub.disconnectDevice(device.id);
      res.status(200).json({ ok: true });
    })
  );

  app.get(
    '/push/vapid-public-key',
    asyncHandler(async (_req, res) => {
      if (!vapidPublicKey) {
        res.status(404).json({ error: 'Push notifications are not configured on this relay' });
        return;
      }
      res.status(200).json({ publicKey: vapidPublicKey });
    })
  );

  app.post(
    '/devices/push-subscription',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const subscription = PushSubscriptionPayload.parse(req.body);
      await store.setPushSubscription(device.id, subscription);
      res.status(200).json({ ok: true });
    })
  );

  app.delete(
    '/devices/push-subscription',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      await store.setPushSubscription(device.id, undefined);
      res.status(200).json({ ok: true });
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // An 'error' event with no listener is an uncaught exception, which terminates the process.
  wss.on('error', () => {});

  wss.on('connection', (ws, req) => {
    // Attached first, before any async work, so a malformed frame arriving immediately after
    // the handshake cannot crash the process. The 'close' handler still fires afterwards.
    ws.on('error', () => {});

    void (async () => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost');
        const token = url.searchParams.get('token');
        if (!token) {
          ws.close(4401, 'Missing token');
          return;
        }
        const device = await pairing.verifyToken(token);
        if (!device) {
          ws.close(4401, 'Invalid token');
          return;
        }

        const connection: Connection = {
          deviceId: device.id,
          userId: device.userId,
          deviceType: device.type,
          send: (message) => ws.send(JSON.stringify(message)),
          close: () => ws.close(4403, 'Device unpaired'),
        };
        hub.register(connection);

        ws.on('message', (raw) => {
          void (async () => {
            try {
              const parsed = RelayMessage.parse(JSON.parse(raw.toString()));
              if (parsed.kind === 'event' && device.type === 'daemon') {
                await hub.routeFromDaemon(connection, parsed.sessionId, parsed.event);
              } else if (parsed.kind === 'command' && device.type === 'browser') {
                await hub.routeFromBrowser(connection, parsed.sessionId, parsed.command);
              }
            } catch (err) {
              // Diagnostic frame — deliberately not part of the RelayMessage schema.
              const message = err instanceof Error ? err.message : String(err);
              try {
                ws.send(JSON.stringify({ kind: 'error', message }));
              } catch {
                // Socket already gone; nothing useful to do, and throwing here would
                // surface as an unhandled rejection.
              }
            }
          })();
        });

        ws.on('close', () => hub.unregister(connection));
      } catch {
        // Unexpected error during setup (e.g., store failure) — close cleanly.
        ws.close(1011, 'Internal error');
      }
    })();
  });

  return httpServer;
}
```

- [ ] **Step 4: Wire VAPID env vars in `main.ts`**

Replace the full contents of `packages/relay/src/main.ts` with:

```ts
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import { WebPushSender } from './web-push-sender.js';

const PORT = Number(process.env.COMPANION_RELAY_PORT ?? 8787);
const HOST = process.env.COMPANION_RELAY_HOST ?? '0.0.0.0';

const vapidPublicKey = process.env.COMPANION_RELAY_VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.COMPANION_RELAY_VAPID_PRIVATE_KEY;
const vapidSubject = process.env.COMPANION_RELAY_VAPID_SUBJECT;

const pushSender =
  vapidPublicKey && vapidPrivateKey && vapidSubject
    ? new WebPushSender({ vapidPublicKey, vapidPrivateKey, vapidSubject })
    : undefined;

if (!pushSender) {
  console.log(
    'Push notifications are disabled: set COMPANION_RELAY_VAPID_PUBLIC_KEY, ' +
      'COMPANION_RELAY_VAPID_PRIVATE_KEY, and COMPANION_RELAY_VAPID_SUBJECT to enable them.'
  );
}

const store = new InMemoryStore();
const pubsub = new InMemoryPubSub();
const httpServer = await createRelayServer({ store, pubsub, pushSender, vapidPublicKey });

httpServer.listen(PORT, HOST, () => {
  console.log(`Companion relay listening on http://${HOST}:${PORT}`);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- server.test`
Expected: PASS (all tests in the file, including the 7 new ones)

Run: `npm test -w @companion/relay`
Expected: PASS — the full relay suite, confirming Tasks 2/3/4's changes still work alongside this task's.

Run: `npm run build -w @companion/relay`
Expected: PASS with no type errors.

- [ ] **Step 6: Update the relay README**

In `packages/relay/README.md`, the `## Run` section currently reads:

```markdown
## Run

    npm run build
    npm start

Set `COMPANION_RELAY_PORT` (default `8787`) and `COMPANION_RELAY_HOST`
(default `0.0.0.0` — unlike the daemon, this server is meant to be
publicly reachable) to configure the listener.
```

Replace with:

```markdown
## Run

    npm run build
    npm start

Set `COMPANION_RELAY_PORT` (default `8787`) and `COMPANION_RELAY_HOST`
(default `0.0.0.0` — unlike the daemon, this server is meant to be
publicly reachable) to configure the listener.

Set `COMPANION_RELAY_VAPID_PUBLIC_KEY`, `COMPANION_RELAY_VAPID_PRIVATE_KEY`,
and `COMPANION_RELAY_VAPID_SUBJECT` (a `mailto:` URI, required by the Web
Push protocol) to enable push notifications. All three must be set together
or none take effect — with any missing, the relay runs exactly as it does
today and `GET /push/vapid-public-key` returns `404`.
```

The `## REST endpoints` section currently reads:

```markdown
## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /devices/me` — the calling device's own `{ id, type, name, createdAt }`
  (never includes `tokenHash` or `userId`).
- `POST /devices/unpair` — revokes the calling device's token so it can
  never authenticate again, and force-closes every live WebSocket
  connection currently authenticated as that device (including the one
  that made this request, if any). `200 { ok: true }` on success. There is
  no way to unpair a device other than the one making the request — the
  target is always the caller, identified by its own bearer token.
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
always succeeds for an authenticated caller:
`200` with a JSON array, empty when the caller has no active sessions.
`GET /sessions/:id`, `GET /sessions/:id/events`, and
`POST /sessions/:id/dismiss` only serve sessions belonging to that device's
user; anything else (missing, or owned by someone else) returns
`404 Unknown session` (never `403`, so session ids cannot be enumerated).
`POST /sessions/:id/dismiss` additionally returns `409` if the session
exists but hasn't stopped yet.
```

Replace with:

```markdown
## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /devices/me` — the calling device's own `{ id, type, name, createdAt }`
  (never includes `tokenHash` or `userId`).
- `POST /devices/unpair` — revokes the calling device's token so it can
  never authenticate again, and force-closes every live WebSocket
  connection currently authenticated as that device (including the one
  that made this request, if any). `200 { ok: true }` on success. There is
  no way to unpair a device other than the one making the request — the
  target is always the caller, identified by its own bearer token.
- `GET /push/vapid-public-key` — the relay's public VAPID key, needed by a
  browser to subscribe to push. Unauthenticated (the key isn't secret).
  `404` if the relay has no VAPID keys configured.
- `POST /devices/push-subscription` `{ endpoint, keys: { p256dh, auth } }`
  — stores a Web Push subscription against the calling device.
  `200 { ok: true }` on success, `400` on an invalid subscription body.
- `DELETE /devices/push-subscription` — clears the calling device's
  subscription. `200 { ok: true }` on success (idempotent — succeeds even
  if there was no subscription to clear).
- `GET /sessions/active` — every one of the caller's sessions that isn't
  dismissed: anything not yet stopped, plus anything stopped but not yet
  dismissed. `200` with a (possibly empty) JSON array.
- `POST /sessions/:id/dismiss` — marks a stopped session dismissed, removing
  it from `GET /sessions/active`. `200` on success, `409` if the session
  isn't stopped yet, `404` if unknown or not owned by the caller.
- `GET /sessions/:id` — current session status (for reconnect/catch-up).
- `GET /sessions/:id/events?since=<seq>` — session event history.

`GET /devices/me`, `POST /devices/unpair`, `POST`/`DELETE
/devices/push-subscription`, and all four `/sessions*` routes require
`Authorization: Bearer <device-token>`; unauthenticated requests get `401`.
`GET /push/vapid-public-key` is the one exception — it's intentionally
public. `GET /sessions/active` isn't scoped to a single session id, so it
always succeeds for an authenticated caller:
`200` with a JSON array, empty when the caller has no active sessions.
`GET /sessions/:id`, `GET /sessions/:id/events`, and
`POST /sessions/:id/dismiss` only serve sessions belonging to that device's
user; anything else (missing, or owned by someone else) returns
`404 Unknown session` (never `403`, so session ids cannot be enumerated).
`POST /sessions/:id/dismiss` additionally returns `409` if the session
exists but hasn't stopped yet.
```

The `## Current scope (v1)` section's last bullet currently reads:

```markdown
- Web Push notification delivery is not implemented — events are stored
  and routed to connected clients only.
```

Replace with:

```markdown
- Web Push notifications fire for `permission_request`, `error`, and
  `stopped` events, sent to every one of the recipient's browser devices
  with a stored subscription. Delivery is best-effort: a failed send to
  one device never blocks another device's, or the event's normal routing
  to connected clients.
```

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts packages/relay/src/main.ts packages/relay/README.md
git commit -m "feat(relay): add push subscription and VAPID public key endpoints"
```

---

### Task 6: Web — `api/push.ts` client

**Files:**
- Create: `packages/web/src/api/push.ts`
- Test: `packages/web/src/api/push.test.ts`

**Interfaces:**
- Consumes: `RELAY_HTTP_URL` from `../config` (existing); `UnauthorizedError` from `./sessions` (existing, reused); `PushSubscriptionPayload` from `@companion/protocol` (Task 1).
- Produces: `getVapidPublicKey(): Promise<string | undefined>` (undefined on 404), `savePushSubscription(token: string, subscription: PushSubscriptionPayload): Promise<void>`, `deletePushSubscription(token: string): Promise<void>`. Consumed by Task 7.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/api/push.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getVapidPublicKey, savePushSubscription, deletePushSubscription } from './push';
import { UnauthorizedError } from './sessions';

describe('push API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getVapidPublicKey returns the key on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ publicKey: 'abc' }) })));
    expect(await getVapidPublicKey()).toBe('abc');
  });

  it('getVapidPublicKey returns undefined on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    expect(await getVapidPublicKey()).toBeUndefined();
  });

  it('getVapidPublicKey throws on a non-404 error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(getVapidPublicKey()).rejects.toThrow('HTTP 500');
  });

  it('savePushSubscription resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(
      savePushSubscription('tok-1', { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } })
    ).resolves.toBeUndefined();
  });

  it('savePushSubscription sends the subscription as the request body', async () => {
    const subscription = { endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual(subscription);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await savePushSubscription('tok-1', subscription);
  });

  it('savePushSubscription throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(
      savePushSubscription('bad-token', { endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } })
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('deletePushSubscription resolves on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    await expect(deletePushSubscription('tok-1')).resolves.toBeUndefined();
  });

  it('deletePushSubscription throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(deletePushSubscription('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- api/push`
Expected: FAIL — `./push` doesn't exist yet.

- [ ] **Step 3: Implement `api/push.ts`**

Create `packages/web/src/api/push.ts`:

```ts
import type { PushSubscriptionPayload } from '@companion/protocol';
import { RELAY_HTTP_URL } from '../config';
import { UnauthorizedError } from './sessions';

export async function getVapidPublicKey(): Promise<string | undefined> {
  const res = await fetch(`${RELAY_HTTP_URL}/push/vapid-public-key`);
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Failed to fetch the VAPID public key: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { publicKey: string };
  return body.publicKey;
}

export async function savePushSubscription(token: string, subscription: PushSubscriptionPayload): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/push-subscription`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(subscription),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to save push subscription: HTTP ${res.status}`);
  }
}

export async function deletePushSubscription(token: string): Promise<void> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/push-subscription`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(`Failed to delete push subscription: HTTP ${res.status}`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- api/push`
Expected: PASS (all 8 tests)

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors. `api/push.ts` is a new standalone file nothing else references yet, so it doesn't affect anything already building cleanly.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/push.ts packages/web/src/api/push.test.ts
git commit -m "feat(web): add push API client (getVapidPublicKey, savePushSubscription, deletePushSubscription)"
```

---

### Task 7: Web — `push-notifications.ts` and the `injectManifest` service worker

**Files:**
- Create: `packages/web/src/push-notifications.ts`
- Test: `packages/web/src/push-notifications.test.ts`
- Create: `packages/web/src/sw.ts`
- Modify: `packages/web/vite.config.ts`
- Modify: `packages/web/package.json`

**Interfaces:**
- Consumes: `getVapidPublicKey`, `savePushSubscription`, `deletePushSubscription` from `./api/push` (Task 6).
- Produces: `PushEnvironment` interface (an injection seam for testability, mirroring `use-relay-connection.ts`'s `createConnection` pattern), `urlBase64ToUint8Array(base64: string): Uint8Array`, `isPushSupported(env?): boolean`, `getPermissionState(env?): NotificationPermission`, `getExistingSubscriptionState(env?): Promise<'subscribed' | 'unsubscribed'>`, `enablePush(token: string, env?): Promise<void>`, `disablePush(token: string, env?): Promise<void>`. Consumed by Task 8.

- [ ] **Step 1: Add the `workbox-precaching`/`workbox-routing` devDependencies**

In `packages/web/package.json`, the `devDependencies` block currently reads:

```json
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.16",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.20.1",
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.1",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-react": "^5.0.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.1.16",
    "typescript": "^7.0.2",
    "vite": "^7.1.12",
    "vite-plugin-pwa": "^0.21.2",
    "vitest": "^4.1.10",
    "ws": "^8.18.0"
  }
```

Replace with:

```json
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.16",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.20.1",
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.1",
    "@types/ws": "^8.18.1",
    "@vitejs/plugin-react": "^5.0.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.1.16",
    "typescript": "^7.0.2",
    "vite": "^7.1.12",
    "vite-plugin-pwa": "^0.21.2",
    "vitest": "^4.1.10",
    "workbox-precaching": "^7.4.1",
    "workbox-routing": "^7.4.1",
    "ws": "^8.18.0"
  }
```

Run: `npm install` from the repo root (`D:/Companion`) to update the lockfile.

- [ ] **Step 2: Write the failing tests**

Create `packages/web/src/push-notifications.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as pushApi from './api/push';
import {
  isPushSupported,
  getPermissionState,
  getExistingSubscriptionState,
  enablePush,
  disablePush,
  urlBase64ToUint8Array,
  type PushEnvironment,
} from './push-notifications';

function fakeEnvironment(overrides: Partial<PushEnvironment> = {}): PushEnvironment {
  return {
    isSupported: () => true,
    getPermission: () => 'default',
    requestPermission: async () => 'granted',
    getRegistration: async () => {
      throw new Error('getRegistration not stubbed for this test');
    },
    ...overrides,
  };
}

describe('push-notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('urlBase64ToUint8Array', () => {
    it('decodes a base64url string into the matching bytes', () => {
      // "hi" encodes to "aGk" in base64url
      expect(Array.from(urlBase64ToUint8Array('aGk'))).toEqual([104, 105]);
    });
  });

  describe('isPushSupported', () => {
    it('delegates to the environment', () => {
      expect(isPushSupported(fakeEnvironment({ isSupported: () => false }))).toBe(false);
      expect(isPushSupported(fakeEnvironment({ isSupported: () => true }))).toBe(true);
    });
  });

  describe('getPermissionState', () => {
    it('delegates to the environment', () => {
      expect(getPermissionState(fakeEnvironment({ getPermission: () => 'denied' }))).toBe('denied');
    });
  });

  describe('getExistingSubscriptionState', () => {
    it('returns subscribed when a subscription exists', async () => {
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => ({}) } }) as any,
      });
      expect(await getExistingSubscriptionState(env)).toBe('subscribed');
    });

    it('returns unsubscribed when there is no subscription', async () => {
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => undefined } }) as any,
      });
      expect(await getExistingSubscriptionState(env)).toBe('unsubscribed');
    });

    it('returns unsubscribed without checking the registration when push is unsupported', async () => {
      const getRegistration = vi.fn();
      const env = fakeEnvironment({ isSupported: () => false, getRegistration });
      expect(await getExistingSubscriptionState(env)).toBe('unsubscribed');
      expect(getRegistration).not.toHaveBeenCalled();
    });
  });

  describe('enablePush', () => {
    it('subscribes and saves the subscription', async () => {
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('aGk');
      const savePushSubscription = vi.spyOn(pushApi, 'savePushSubscription').mockResolvedValue(undefined);
      const subscribe = vi.fn(async () => ({
        toJSON: () => ({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } }),
      }));
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { subscribe } }) as any,
      });

      await enablePush('tok-1', env);

      expect(subscribe).toHaveBeenCalledWith(
        expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) })
      );
      expect(savePushSubscription).toHaveBeenCalledWith('tok-1', {
        endpoint: 'https://push.example.com/x',
        keys: { p256dh: 'p', auth: 'a' },
      });
    });

    it('throws if the relay has no VAPID key configured', async () => {
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue(undefined);

      await expect(enablePush('tok-1', fakeEnvironment())).rejects.toThrow('not available');
    });

    it('throws if permission is not granted', async () => {
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('aGk');
      const env = fakeEnvironment({ requestPermission: async () => 'denied' });

      await expect(enablePush('tok-1', env)).rejects.toThrow('not granted');
    });
  });

  describe('disablePush', () => {
    it('unsubscribes and clears the subscription on the relay', async () => {
      const unsubscribe = vi.fn(async () => true);
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }) as any,
      });
      const deletePushSubscription = vi.spyOn(pushApi, 'deletePushSubscription').mockResolvedValue(undefined);

      await disablePush('tok-1', env);

      expect(unsubscribe).toHaveBeenCalled();
      expect(deletePushSubscription).toHaveBeenCalledWith('tok-1');
    });

    it('still clears the relay-side subscription when there is no browser-side subscription', async () => {
      const env = fakeEnvironment({
        getRegistration: async () => ({ pushManager: { getSubscription: async () => undefined } }) as any,
      });
      const deletePushSubscription = vi.spyOn(pushApi, 'deletePushSubscription').mockResolvedValue(undefined);

      await disablePush('tok-1', env);

      expect(deletePushSubscription).toHaveBeenCalledWith('tok-1');
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- push-notifications`
Expected: FAIL — `./push-notifications` doesn't exist yet.

- [ ] **Step 4: Implement `push-notifications.ts`**

Create `packages/web/src/push-notifications.ts`:

```ts
import { getVapidPublicKey, savePushSubscription, deletePushSubscription } from './api/push';

/**
 * Wraps the browser Push/Notification/ServiceWorker APIs behind an injectable interface, the
 * same seam pattern use-relay-connection.ts uses for RelayConnection: jsdom (this project's
 * test environment) implements none of these APIs, so tests construct a plain object matching
 * this shape instead of mutating global browser objects.
 */
export interface PushEnvironment {
  isSupported(): boolean;
  getPermission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getRegistration(): Promise<ServiceWorkerRegistration>;
}

const defaultEnvironment: PushEnvironment = {
  isSupported: () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window,
  getPermission: () => (typeof Notification === 'undefined' ? 'denied' : Notification.permission),
  requestPermission: () => Notification.requestPermission(),
  getRegistration: () => navigator.serviceWorker.ready,
};

/** Web Push's applicationServerKey must be raw bytes, but VAPID public keys are handed around
 * as base64url text — this is the standard decode routine for that conversion. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function isPushSupported(env: PushEnvironment = defaultEnvironment): boolean {
  return env.isSupported();
}

export function getPermissionState(env: PushEnvironment = defaultEnvironment): NotificationPermission {
  return env.getPermission();
}

export async function getExistingSubscriptionState(
  env: PushEnvironment = defaultEnvironment
): Promise<'subscribed' | 'unsubscribed'> {
  if (!env.isSupported()) return 'unsubscribed';
  const registration = await env.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'unsubscribed';
}

export async function enablePush(token: string, env: PushEnvironment = defaultEnvironment): Promise<void> {
  const publicKey = await getVapidPublicKey();
  if (!publicKey) {
    throw new Error('Push notifications are not available on this server');
  }
  const permission = await env.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted');
  }
  const registration = await env.getRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const json = subscription.toJSON();
  await savePushSubscription(token, {
    endpoint: json.endpoint!,
    keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
  });
}

export async function disablePush(token: string, env: PushEnvironment = defaultEnvironment): Promise<void> {
  const registration = await env.getRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await subscription.unsubscribe();
  }
  await deletePushSubscription(token);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- push-notifications`
Expected: PASS (all 11 tests)

- [ ] **Step 6: Switch the PWA to `injectManifest` mode and add the custom service worker**

Replace the full contents of `packages/web/vite.config.ts` with:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest (not the default generateSW) is required so src/sw.ts can add its own
      // push/notificationclick listeners — generateSW only ever produces a precaching-only
      // service worker with no hook for custom event handlers. The SPA navigation fallback
      // that used to be configured here via workbox.navigateFallback is now implemented
      // directly in src/sw.ts via workbox-routing's NavigationRoute.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
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
  ],
});
```

Create `packages/web/src/sw.ts`:

```ts
/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// The app has real client-side routes (/sessions/:id, /settings); without this, a direct or
// offline-cached navigation to one falls through to a 404 instead of the SPA shell client-side
// routing needs. Equivalent to the old generateSW config's workbox.navigateFallback: '/index.html'.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: { title: string; body: string; url: string };
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Collapses repeat notifications for the same session into one, rather than stacking.
      tag: payload.url,
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url: string } | undefined)?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          void client.focus();
          if ('navigate' in client) {
            void (client as WindowClient).navigate(url);
          }
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
```

`sw.ts` is not covered by this task's unit tests — there is no real `ServiceWorkerGlobalScope` in Vitest/jsdom, so its correctness is verified by the build step below (which runs it through Workbox's real `injectManifest` pipeline) rather than a unit test. This is an accepted gap, consistent with `main.ts` already being untested in this project (see the spec's Testing Strategy).

- [ ] **Step 7: Run the full web build to verify the service worker compiles and generates correctly**

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors. Check the build log for `PWA v0.21.2` and `mode injectManifest`, and confirm `dist/sw.js` was generated — this confirms Workbox's `injectManifest` pipeline found and processed `src/sw.ts` correctly, including resolving `self.__WB_MANIFEST` and the `workbox-precaching`/`workbox-routing` imports.

- [ ] **Step 8: Commit**

```bash
git add packages/web/package.json package-lock.json packages/web/src/push-notifications.ts packages/web/src/push-notifications.test.ts packages/web/src/sw.ts packages/web/vite.config.ts
git commit -m "feat(web): add push-notifications module and switch service worker to injectManifest"
```

---

### Task 8: Web — `SettingsScreen` notifications section, web README

**Files:**
- Modify: `packages/web/src/SettingsScreen.tsx`
- Modify: `packages/web/src/SettingsScreen.test.tsx`
- Modify: `packages/web/README.md`

**Interfaces:**
- Consumes: `isPushSupported`, `getPermissionState`, `getExistingSubscriptionState`, `enablePush`, `disablePush` from `./push-notifications` (Task 7); `getVapidPublicKey` from `./api/push` (Task 6).
- Produces: nothing consumed by other tasks — this is the final integration point.

- [ ] **Step 1: Write the failing tests**

`packages/web/src/SettingsScreen.test.tsx`'s imports currently read:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SettingsScreen from './SettingsScreen';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';
```

Replace with:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SettingsScreen from './SettingsScreen';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';
import * as pushApi from './api/push';
import * as pushNotifications from './push-notifications';
```

Add this new `describe` block at the end of the file, right before the final closing `});` of the outer `describe('SettingsScreen', ...)` block (i.e. right after the existing `'has a link back to the session list'` test):

```tsx

  describe('notifications section', () => {
    function mockDeviceLoad() {
      vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
        id: 'dev-1',
        type: 'browser',
        name: 'Chrome on Mac',
        createdAt: 1,
      });
    }

    it('renders nothing when push is not supported by the browser', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(false);

      renderSettings();

      await screen.findByText('Chrome on Mac');
      expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    });

    it('renders nothing when the relay has no VAPID key configured', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue(undefined);

      renderSettings();

      await screen.findByText('Chrome on Mac');
      expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    });

    it('shows an Enable button when push is available but not yet subscribed', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');

      renderSettings();

      expect(await screen.findByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
    });

    it('shows a Disable button when already subscribed', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('granted');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('subscribed');

      renderSettings();

      expect(await screen.findByRole('button', { name: /disable notifications/i })).toBeInTheDocument();
    });

    it('shows a blocked message instead of a button when permission was previously denied', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('denied');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');

      renderSettings();

      expect(await screen.findByText(/blocked in your browser settings/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /enable notifications/i })).not.toBeInTheDocument();
    });

    it('enables push notifications and shows the Disable button after clicking Enable', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');
      const enablePush = vi.spyOn(pushNotifications, 'enablePush').mockResolvedValue(undefined);

      renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /enable notifications/i }));

      expect(enablePush).toHaveBeenCalledWith('tok-1');
      expect(await screen.findByRole('button', { name: /disable notifications/i })).toBeInTheDocument();
    });

    it('shows an inline error and does not change state when enabling push fails', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');
      vi.spyOn(pushNotifications, 'enablePush').mockRejectedValue(
        new Error('Notification permission was not granted')
      );

      renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /enable notifications/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Notification permission was not granted');
      expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
    });

    it('disables push notifications and shows the Enable button after clicking Disable', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('granted');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('subscribed');
      const disablePush = vi.spyOn(pushNotifications, 'disablePush').mockResolvedValue(undefined);

      renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /disable notifications/i }));

      expect(disablePush).toHaveBeenCalledWith('tok-1');
      expect(await screen.findByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
    });

    it('calls onUnpaired if enabling push gets a 401', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');
      vi.spyOn(pushNotifications, 'enablePush').mockRejectedValue(new UnauthorizedError());

      const onUnpaired = renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /enable notifications/i }));

      await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- SettingsScreen`
Expected: FAIL — none of the notifications-section UI exists yet, so the new tests can't find the buttons/text they look for.

- [ ] **Step 3: Add the notifications section**

Replace the full contents of `packages/web/src/SettingsScreen.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getDevice, unpairDevice, type DeviceInfo } from './api/devices';
import { UnauthorizedError } from './api/sessions';
import { getVapidPublicKey } from './api/push';
import {
  isPushSupported,
  getPermissionState,
  getExistingSubscriptionState,
  enablePush,
  disablePush,
} from './push-notifications';

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
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>('default');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | undefined>();
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

  useEffect(() => {
    let cancelled = false;
    async function loadPushState() {
      if (!isPushSupported()) return;
      const publicKey = await getVapidPublicKey();
      if (cancelled || !publicKey) return;
      setPushAvailable(true);
      setPushPermission(getPermissionState());
      const state = await getExistingSubscriptionState();
      if (!cancelled) setPushSubscribed(state === 'subscribed');
    }
    void loadPushState();
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function handleEnablePush() {
    setPushBusy(true);
    setPushError(undefined);
    try {
      await enablePush(token);
      setPushSubscribed(true);
      setPushPermission(getPermissionState());
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      setPushError(err instanceof Error ? err.message : String(err));
      setPushPermission(getPermissionState());
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisablePush() {
    setPushBusy(true);
    setPushError(undefined);
    try {
      await disablePush(token);
      setPushSubscribed(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushBusy(false);
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
          {loadError}
        </p>
      )}

      {device && (
        <div className="bg-slate-800 rounded-md p-4 space-y-1">
          <p className="font-medium">{device.name}</p>
          <p className="text-sm text-slate-400 capitalize">{device.type}</p>
          <p className="text-sm text-slate-400">Paired {new Date(device.createdAt).toLocaleDateString()}</p>
        </div>
      )}

      {pushAvailable && (
        <div className="border-t border-slate-700 pt-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-300">Notifications</h2>
          {pushPermission === 'denied' ? (
            <p className="text-sm text-slate-400">
              Notifications are blocked in your browser settings. Change your browser's site permissions to enable
              them.
            </p>
          ) : pushSubscribed ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-400">Notifications are enabled for this device.</p>
              <button
                type="button"
                onClick={handleDisablePush}
                disabled={pushBusy}
                className="w-full rounded-md bg-slate-800 px-3 py-2 font-medium disabled:opacity-50"
              >
                {pushBusy ? 'Disabling…' : 'Disable notifications'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleEnablePush}
              disabled={pushBusy}
              className="w-full rounded-md bg-blue-600 px-3 py-2 font-medium disabled:opacity-50"
            >
              {pushBusy ? 'Enabling…' : 'Enable notifications'}
            </button>
          )}
          {pushError && (
            <p role="alert" className="text-sm text-red-400">
              {pushError}
            </p>
          )}
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- SettingsScreen`
Expected: PASS (all 18 tests — the 9 pre-existing plus 9 new)

- [ ] **Step 5: Run the full web test suite and build**

Run: `npm test -w @companion/web`
Expected: PASS — all tests across the package, including every prior task's new/modified files.

Run: `npm run build -w @companion/web`
Expected: PASS with no type errors, PWA artifacts generated (`dist/sw.js` present, `mode injectManifest` in the build log).

- [ ] **Step 6: Update the web README**

In `packages/web/README.md`, the `/settings` bullet under `## Views` currently reads:

```markdown
- `/settings` — `SettingsScreen`: this device's paired info (name, type,
  paired date) and an "Unpair this device" action behind a confirm step.
  Unpairing calls the relay to revoke the device's token server-side and
  force-close any other live tab using it, then clears local storage and
  returns to the pairing screen — there is no separate "logout" distinct
  from unpairing, since the device token is the only credential this app
  has.
```

Replace with:

```markdown
- `/settings` — `SettingsScreen`: this device's paired info (name, type,
  paired date), an "Unpair this device" action behind a confirm step, and
  (when the browser supports Push and the relay has VAPID keys configured)
  a notifications toggle for this device. Unpairing calls the relay to
  revoke the device's token server-side and force-close any other live tab
  using it, then clears local storage and returns to the pairing screen —
  there is no separate "logout" distinct from unpairing, since the device
  token is the only credential this app has.
```

Add a new section right after `## Views` (before `## Follow-up (not in this plan)`):

```markdown
## Service Worker

`vite-plugin-pwa` uses the `injectManifest` strategy with a custom source
file at `src/sw.ts` (rather than the default `generateSW`), specifically so
it can add `push`/`notificationclick` listeners alongside the standard
offline-caching precache route — `generateSW` only ever produces a
precaching-only service worker with no hook for custom event handlers.

iOS Safari only supports Web Push for a PWA that's been added to the home
screen, not a regular browser tab — a platform constraint outside this
app's control. `SettingsScreen`'s notifications section hides itself
wherever `isPushSupported()` returns false, which covers this case without
any special detection: iOS Safari simply doesn't expose `PushManager` in an
un-installed tab.
```

The `## Follow-up (not in this plan)` section currently reads:

```markdown
## Follow-up (not in this plan)

- Real PWA icon set (`vite.config.ts`'s `manifest.icons` is currently empty).
- Web Push notifications — the relay doesn't implement delivery yet.
```

Replace with:

```markdown
## Follow-up (not in this plan)

- Real PWA icon set (`vite.config.ts`'s `manifest.icons` is currently empty).
```

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/SettingsScreen.tsx packages/web/src/SettingsScreen.test.tsx packages/web/README.md
git commit -m "feat(web): add notifications toggle to SettingsScreen"
```

---

## Final Verification

After all 8 tasks are complete:

Run: `npm test` from the repo root (`D:/Companion`)
Expected: PASS across all four packages (`@companion/daemon`, `@companion/protocol`, `@companion/relay`, `@companion/web`).

Run: `npm run build` from the repo root
Expected: PASS with no type errors, `@companion/web`'s Vite build succeeds with PWA artifacts generated (`dist/sw.js` present).
