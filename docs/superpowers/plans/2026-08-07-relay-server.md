# Relay Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@companion/relay`, the hosted relay server that pairs daemon and browser devices for a user, routes `SessionEvent`s from daemon → browsers and `Command`s from browser → daemon, and persists both durably — fully testable standalone against in-memory storage/pub-sub, with no dependency on the real daemon, a real browser, or real Postgres/Redis.

**Architecture:** Two small port interfaces — `Store` (durable state: users, devices, pairing codes, sessions, session events) and `PubSub` (cross-relay-instance message fan-out) — sit behind a `ConnectionHub` that owns all routing logic and is transport-agnostic (it talks to a `Connection` interface, not raw WebSockets). An Express + `ws` server wires real HTTP/WebSocket transport to the Hub. This plan implements and tests everything against in-memory `Store`/`PubSub` adapters; swapping in real Postgres/Redis-backed adapters later touches only those two files, never `hub.ts`, `pairing.ts`, or `server.ts` — mirroring how Plan 1 split `agent-sdk-port.ts` from `real-agent-sdk.ts`.

**Tech Stack:** Node.js + TypeScript (NodeNext modules), npm workspaces, `ws` (WebSocket server/client), Express (REST), Zod (`@companion/protocol`), Vitest, Supertest.

## Global Constraints

- Node.js + TypeScript across all packages, npm workspaces (existing monorepo from Plan 1).
- Unlike the daemon (outbound-only, bound to `127.0.0.1` only), the relay is the **intentionally publicly-reachable** piece of the system — binding to all interfaces is correct and expected here, not a violation of the daemon's security constraint.
- All persistent state goes through the `Store` port; all cross-instance message routing goes through the `PubSub` port. This plan builds and tests only in-memory implementations of both — real Postgres/Redis-backed implementations are explicitly out of scope for this plan (future work), matching the port/adapter split established in Plan 1.
- The wire envelope (`RelayMessage`) and pairing request schema live in `@companion/protocol`, alongside the existing `SessionEvent`/`Command` schemas from Plan 1, so daemon/relay/web-app share one typed contract.
- **v1 scope simplification** (deliberately narrower than the full design spec, for efficiency): a single seeded default user (no public signup); requesting a pairing code requires no prior authentication, which bootstraps the very first device. The spec's "an already-authenticated device requests a code for a new device" flow is deferred until multi-device pairing actually needs it.
- **Out of scope for this plan:** routing a `start_session` command through the relay (a browser cannot yet remotely trigger a brand-new session — only session-scoped commands on an already-started session: `inject_prompt`, `respond_to_permission`, `pause`, `resume`, `stop`). Web Push notification delivery is also out of scope (future work) — this plan only stores/routes events, it doesn't send push notifications yet.

---

## Task 1: Monorepo addition — scaffold `packages/relay`

**Files:**
- Create: `packages/relay/package.json`, `packages/relay/tsconfig.json`, `packages/relay/vitest.config.ts`
- Create: `packages/relay/src/index.ts` (placeholder), `packages/relay/src/smoke.test.ts`
- Modify: root `package.json` (add relay to the build sequence)

**Interfaces:**
- Produces: a fourth workspace package, `@companion/relay`, buildable and testable from the repo root alongside `protocol` and `daemon`.

- [ ] **Step 1: Scaffold the package**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
mkdir -p packages/relay/src
cd packages/relay
npm init -y
npm install express ws @companion/protocol@*
npm install -D typescript vitest supertest @types/express @types/supertest @types/node @types/ws
```

If `@companion/protocol@*` doesn't resolve from inside `packages/relay`, run the install commands from the repo root instead, e.g. `npm install express ws -w @companion/relay` and `npm install @companion/protocol@* -w @companion/relay`.

Edit `packages/relay/package.json` to:

```json
{
  "name": "@companion/relay",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@companion/protocol": "*",
    "express": "^4.21.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "supertest": "^7.0.0",
    "@types/express": "^4.17.0",
    "@types/supertest": "^6.0.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0"
  }
}
```

(Leave whatever exact versions `npm install` wrote — this block is the shape to edit into, not literal values to force, consistent with how Plan 1 handled this.)

Create `packages/relay/tsconfig.json`:

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

Create `packages/relay/vitest.config.ts` (this excludes `dist/` from test discovery from day one — Plan 1 hit a recurring bug where stale compiled `dist/*.test.js` files got double-counted by vitest; starting this package with the fix already in place avoids repeating that):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
```

Create `packages/relay/src/index.ts`:

```ts
export const RELAY_PLACEHOLDER = true;
```

Create `packages/relay/src/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RELAY_PLACEHOLDER } from './index.js';

describe('relay package scaffold', () => {
  it('loads', () => {
    expect(RELAY_PLACEHOLDER).toBe(true);
  });
});
```

- [ ] **Step 2: Add relay to the root build sequence**

Edit the root `package.json`'s `build` script (it currently reads `"npm run build -w @companion/protocol && npm run build -w @companion/daemon"`) to also build relay, after protocol (relay depends on protocol, not on daemon):

```json
"build": "npm run build -w @companion/protocol && npm run build -w @companion/daemon && npm run build -w @companion/relay"
```

- [ ] **Step 3: Verify the workspace runs**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
npm test
```

Expected: all four packages' test suites pass, including the new relay smoke test.

```bash
rm -rf packages/*/dist packages/*/*.tsbuildinfo
npm run build
```

Expected: builds in one shot, protocol → daemon → relay, no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json packages/relay
git commit -m "chore: scaffold @companion/relay package"
```

---

## Task 2: Protocol addition — relay wire envelope and pairing schema

**Files:**
- Create: `packages/protocol/src/relay.ts`
- Create: `packages/protocol/src/relay.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- Consumes: `SessionEvent` (from `packages/protocol/src/events.ts`), `Command` (from `packages/protocol/src/commands.ts`) — both from Plan 1.
- Produces: `RelayMessage` (Zod discriminated union on `kind`: `'event' | 'command'`, each carrying `sessionId` plus the wrapped payload) and `RedeemPairingRequest` (Zod object: `code`, `deviceType`, `deviceName`). Task 4 (`PairingService`) and Task 6 (the relay server) import these exact names from `@companion/protocol`.

- [ ] **Step 1: Write the failing tests**

Create `packages/protocol/src/relay.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RelayMessage, RedeemPairingRequest } from './relay.js';

describe('RelayMessage schema', () => {
  it('accepts a valid event envelope', () => {
    const result = RelayMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid command envelope', () => {
    const result = RelayMessage.safeParse({
      kind: 'command',
      sessionId: 'sess-1',
      command: { type: 'pause', sessionId: 'sess-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope with an invalid kind', () => {
    const result = RelayMessage.safeParse({ kind: 'nope', sessionId: 'sess-1' });
    expect(result.success).toBe(false);
  });
});

describe('RedeemPairingRequest schema', () => {
  it('accepts a valid redeem request', () => {
    const result = RedeemPairingRequest.safeParse({
      code: '123456',
      deviceType: 'daemon',
      deviceName: 'my-laptop',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid deviceType', () => {
    const result = RedeemPairingRequest.safeParse({
      code: '123456',
      deviceType: 'toaster',
      deviceName: 'my-laptop',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "D:/Companion/.claude/worktrees/relay-server/packages/protocol"
npx vitest run src/relay.test.ts
```

Expected: FAIL — `./relay.js` does not exist.

- [ ] **Step 3: Implement `relay.ts`**

Create `packages/protocol/src/relay.ts`:

```ts
import { z } from 'zod';
import { SessionEvent } from './events.js';
import { Command } from './commands.js';

export const RelayMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    sessionId: z.string(),
    event: SessionEvent,
  }),
  z.object({
    kind: z.literal('command'),
    sessionId: z.string(),
    command: Command,
  }),
]);
export type RelayMessage = z.infer<typeof RelayMessage>;

export const RedeemPairingRequest = z.object({
  code: z.string(),
  deviceType: z.enum(['daemon', 'browser']),
  deviceName: z.string(),
});
export type RedeemPairingRequest = z.infer<typeof RedeemPairingRequest>;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/relay.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Wire up the package entrypoint**

Edit `packages/protocol/src/index.ts` to add:

```ts
export * from './relay.js';
```

(alongside the existing `export * from './events.js';` and `export * from './commands.js';`).

- [ ] **Step 6: Run the full protocol suite**

```bash
npx vitest run
```

Expected: PASS (11 tests: 4 events + 3 commands + 4 relay).

- [ ] **Step 7: Commit**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
git add packages/protocol
git commit -m "feat(protocol): add RelayMessage envelope and RedeemPairingRequest schemas"
```

---

## Task 3: Relay — `Store` and `PubSub` ports with in-memory implementations

**Files:**
- Create: `packages/relay/src/store.ts`
- Create: `packages/relay/src/in-memory-store.ts`
- Create: `packages/relay/src/in-memory-store.test.ts`
- Create: `packages/relay/src/pubsub.ts`
- Create: `packages/relay/src/in-memory-pubsub.ts`
- Create: `packages/relay/src/in-memory-pubsub.test.ts`
- Delete: `packages/relay/src/smoke.test.ts` (superseded)

**Interfaces:**
- Consumes: `SessionEvent`, `SessionStatus` (from `@companion/protocol`, Plan 1).
- Produces: `Store` interface (`getOrCreateDefaultUser`, `createDevice`, `getDeviceByTokenHash`, `createPairingCode`, `consumePairingCode`, `upsertSession`, `updateSessionStatus`, `getSession`, `appendSessionEvent`, `getSessionEvents`) plus `User`, `Device`, `PairingCode`, `SessionRecord`, `StoredSessionEvent` types; `InMemoryStore implements Store`. `PubSub` interface (`publish`, `subscribe`) plus `InMemoryPubSub implements PubSub`. Tasks 4, 5, and 6 are written entirely against these interfaces.

- [ ] **Step 1: Write the failing tests for the in-memory store**

Create `packages/relay/src/in-memory-store.test.ts`:

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
    });
    await store.updateSessionStatus('sess-1', 'paused');

    const session = await store.getSession('sess-1');
    expect(session?.status).toBe('paused');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "D:/Companion/.claude/worktrees/relay-server/packages/relay"
npx vitest run src/in-memory-store.test.ts
```

Expected: FAIL — `./in-memory-store.js` does not exist.

- [ ] **Step 3: Implement the `Store` port and `InMemoryStore`**

Create `packages/relay/src/store.ts`:

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
}

export interface StoredSessionEvent {
  seq: number;
  sessionId: string;
  event: SessionEvent;
  createdAt: number;
}

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
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
}
```

Create `packages/relay/src/in-memory-store.ts`:

```ts
import { randomInt, randomUUID } from 'node:crypto';
import type { SessionEvent, SessionStatus } from '@companion/protocol';
import type {
  Device,
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
    return stored;
  }

  async getSessionEvents(sessionId: string, sinceSeq = 0): Promise<StoredSessionEvent[]> {
    const list = this.events.get(sessionId) ?? [];
    return list.filter((e) => e.seq > sinceSeq);
  }
}
```

- [ ] **Step 4: Run the store tests to verify they pass**

```bash
npx vitest run src/in-memory-store.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing tests for the in-memory pub/sub**

Create `packages/relay/src/in-memory-pubsub.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { InMemoryPubSub } from './in-memory-pubsub.js';

describe('InMemoryPubSub', () => {
  it('delivers a published message to a subscribed handler', async () => {
    const pubsub = new InMemoryPubSub();
    const handler = vi.fn();
    pubsub.subscribe('channel-a', handler);

    await pubsub.publish('channel-a', { hello: 'world' });

    expect(handler).toHaveBeenCalledWith({ hello: 'world' });
  });

  it('delivers to every subscriber on the same channel', async () => {
    const pubsub = new InMemoryPubSub();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    pubsub.subscribe('channel-a', handlerA);
    pubsub.subscribe('channel-a', handlerB);

    await pubsub.publish('channel-a', 'ping');

    expect(handlerA).toHaveBeenCalledWith('ping');
    expect(handlerB).toHaveBeenCalledWith('ping');
  });

  it('does not deliver to a handler on a different channel', async () => {
    const pubsub = new InMemoryPubSub();
    const handler = vi.fn();
    pubsub.subscribe('channel-a', handler);

    await pubsub.publish('channel-b', 'ping');

    expect(handler).not.toHaveBeenCalled();
  });

  it('publishing with no subscribers does not throw', async () => {
    const pubsub = new InMemoryPubSub();
    await expect(pubsub.publish('channel-a', 'ping')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run the tests to verify they fail**

```bash
npx vitest run src/in-memory-pubsub.test.ts
```

Expected: FAIL — `./in-memory-pubsub.js` does not exist.

- [ ] **Step 7: Implement the `PubSub` port and `InMemoryPubSub`**

Create `packages/relay/src/pubsub.ts`:

```ts
export interface PubSub {
  publish(channel: string, message: unknown): Promise<void>;
  subscribe(channel: string, handler: (message: unknown) => void): void;
}
```

Create `packages/relay/src/in-memory-pubsub.ts`:

```ts
import type { PubSub } from './pubsub.js';

export class InMemoryPubSub implements PubSub {
  private handlers = new Map<string, Set<(message: unknown) => void>>();

  async publish(channel: string, message: unknown): Promise<void> {
    for (const handler of this.handlers.get(channel) ?? []) {
      handler(message);
    }
  }

  subscribe(channel: string, handler: (message: unknown) => void): void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
  }
}
```

- [ ] **Step 8: Run the pub/sub tests to verify they pass**

```bash
npx vitest run src/in-memory-pubsub.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 9: Remove the scaffold placeholder and run the full relay suite**

Delete `packages/relay/src/smoke.test.ts` (its role — proving the package scaffold works — is now covered by real tests).

```bash
npx vitest run
```

Expected: PASS (11 tests: 7 store + 4 pubsub).

- [ ] **Step 10: Commit**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
git add packages/relay/src/store.ts packages/relay/src/in-memory-store.ts packages/relay/src/in-memory-store.test.ts packages/relay/src/pubsub.ts packages/relay/src/in-memory-pubsub.ts packages/relay/src/in-memory-pubsub.test.ts
git rm packages/relay/src/smoke.test.ts
git commit -m "feat(relay): add Store and PubSub ports with in-memory implementations"
```

---

## Task 4: Relay — `PairingService`

**Files:**
- Create: `packages/relay/src/pairing.ts`
- Create: `packages/relay/src/pairing.test.ts`

**Interfaces:**
- Consumes: `Store`, `Device` (Task 3).
- Produces: `class PairingService` with constructor `(store: Store)` and methods `requestPairingCode(): Promise<{ code: string; expiresAt: number }>`, `redeemPairingCode(code: string, deviceType: 'daemon' | 'browser', deviceName: string): Promise<{ token: string; device: Device } | undefined>`, `verifyToken(token: string): Promise<Device | undefined>`. Task 6 (the relay server) is written against exactly this surface.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay/src/pairing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PairingService } from './pairing.js';
import { InMemoryStore } from './in-memory-store.js';

describe('PairingService', () => {
  it('issues a pairing code that can be redeemed for a device token', async () => {
    const pairing = new PairingService(new InMemoryStore());

    const { code } = await pairing.requestPairingCode();
    const result = await pairing.redeemPairingCode(code, 'daemon', 'my-laptop');

    expect(result).toBeDefined();
    expect(result?.device.type).toBe('daemon');
    expect(result?.device.name).toBe('my-laptop');
    expect(typeof result?.token).toBe('string');
    expect(result?.token.length).toBeGreaterThan(0);
  });

  it('a pairing code cannot be redeemed twice', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode();

    await pairing.redeemPairingCode(code, 'daemon', 'first-device');
    const second = await pairing.redeemPairingCode(code, 'browser', 'second-device');

    expect(second).toBeUndefined();
  });

  it('redeeming an unknown code returns undefined', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.redeemPairingCode('000000', 'daemon', 'x')).toBeUndefined();
  });

  it('verifyToken finds the device that redeemed a valid token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode();
    const result = await pairing.redeemPairingCode(code, 'browser', 'phone');

    const device = await pairing.verifyToken(result!.token);

    expect(device?.id).toBe(result!.device.id);
  });

  it('verifyToken returns undefined for a bogus token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.verifyToken('not-a-real-token')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "D:/Companion/.claude/worktrees/relay-server/packages/relay"
npx vitest run src/pairing.test.ts
```

Expected: FAIL — `./pairing.js` does not exist.

- [ ] **Step 3: Implement `PairingService`**

Create `packages/relay/src/pairing.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Device, Store } from './store.js';

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class PairingService {
  constructor(private store: Store) {}

  async requestPairingCode(): Promise<{ code: string; expiresAt: number }> {
    const user = await this.store.getOrCreateDefaultUser();
    const pairing = await this.store.createPairingCode(user.id);
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  async redeemPairingCode(
    code: string,
    deviceType: 'daemon' | 'browser',
    deviceName: string
  ): Promise<{ token: string; device: Device } | undefined> {
    const pairing = await this.store.consumePairingCode(code);
    if (!pairing) return undefined;
    const token = generateToken();
    const device = await this.store.createDevice({
      userId: pairing.userId,
      type: deviceType,
      name: deviceName,
      tokenHash: hashToken(token),
    });
    return { token, device };
  }

  async verifyToken(token: string): Promise<Device | undefined> {
    return this.store.getDeviceByTokenHash(hashToken(token));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/pairing.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
git add packages/relay/src/pairing.ts packages/relay/src/pairing.test.ts
git commit -m "feat(relay): add PairingService for device pairing and token verification"
```

---

## Task 5: Relay — `ConnectionHub`

**Files:**
- Create: `packages/relay/src/hub.ts`
- Create: `packages/relay/src/hub.test.ts`

**Interfaces:**
- Consumes: `Store`, `SessionRecord` (Task 3); `PubSub` (Task 3); `SessionEvent`, `SessionStatus`, `Command` (from `@companion/protocol`, Plan 1).
- Produces: `interface Connection` (`deviceId: string`, `userId: string`, `deviceType: 'daemon' | 'browser'`, `send(message: RelayHubMessage): void`), `type RelayHubMessage`, and `class ConnectionHub` with constructor `(store: Store, pubsub: PubSub)` and methods `register(connection: Connection): void`, `unregister(deviceId: string): void`, `routeFromDaemon(connection: Connection, sessionId: string, event: SessionEvent): Promise<void>`, `routeFromBrowser(connection: Connection, sessionId: string, command: Command): Promise<void>`. Task 6 (the relay server) is written against exactly this surface, adapting real WebSocket connections to the `Connection` interface.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay/src/hub.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ConnectionHub, type Connection, type RelayHubMessage } from './hub.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';

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

describe('ConnectionHub', () => {
  it('routing a session_started event from a daemon creates the session record', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    const session = await store.getSession('sess-1');
    expect(session).toMatchObject({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'daemon-1',
      status: 'running',
    });
  });

  it('forwards an event from a daemon to browser connections of the same user only', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const myBrowser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    const otherUsersBrowser = fakeConnection({ deviceId: 'browser-2', deviceType: 'browser', userId: 'user-2' });
    hub.register(myBrowser);
    hub.register(otherUsersBrowser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(myBrowser.sent).toHaveLength(1);
    expect(myBrowser.sent[0]).toMatchObject({ kind: 'event', sessionId: 'sess-1' });
    expect(otherUsersBrowser.sent).toHaveLength(0);
  });

  it('updates session status based on subsequent event types and persists the event', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

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

    const session = await store.getSession('sess-1');
    expect(session?.status).toBe('waiting_permission');

    const events = await store.getSessionEvents('sess-1');
    expect(events).toHaveLength(2);
  });

  it('routes a command from a browser to the daemon connection that owns the session', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(browser, 'sess-1', { type: 'pause', sessionId: 'sess-1' });

    expect(daemon.sent).toHaveLength(1);
    expect(daemon.sent[0]).toMatchObject({ kind: 'command', sessionId: 'sess-1' });
  });

  it('routeFromBrowser throws for an unknown session', async () => {
    const hub = new ConnectionHub(new InMemoryStore(), new InMemoryPubSub());
    const browser = fakeConnection();

    await expect(
      hub.routeFromBrowser(browser, 'does-not-exist', { type: 'pause', sessionId: 'does-not-exist' })
    ).rejects.toThrow();
  });

  it('routeFromBrowser throws when the session belongs to a different user', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    const intruder = fakeConnection({ deviceId: 'browser-x', deviceType: 'browser', userId: 'user-2' });

    await expect(
      hub.routeFromBrowser(intruder, 'sess-1', { type: 'pause', sessionId: 'sess-1' })
    ).rejects.toThrow();
  });

  it('unregister removes a connection so it no longer receives events', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);
    hub.unregister('browser-1');

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(browser.sent).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "D:/Companion/.claude/worktrees/relay-server/packages/relay"
npx vitest run src/hub.test.ts
```

Expected: FAIL — `./hub.js` does not exist.

- [ ] **Step 3: Implement `ConnectionHub`**

Create `packages/relay/src/hub.ts`:

```ts
import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
import type { Store } from './store.js';
import type { PubSub } from './pubsub.js';

export interface Connection {
  readonly deviceId: string;
  readonly userId: string;
  readonly deviceType: 'daemon' | 'browser';
  send(message: RelayHubMessage): void;
}

export type RelayHubMessage =
  | { kind: 'event'; sessionId: string; event: SessionEvent }
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

const CHANNEL = 'relay:message';

export class ConnectionHub {
  private connections = new Map<string, Connection>();

  constructor(
    private store: Store,
    private pubsub: PubSub
  ) {
    this.pubsub.subscribe(CHANNEL, (message) => this.dispatchLocal(message as PubSubEnvelope));
  }

  register(connection: Connection): void {
    this.connections.set(connection.deviceId, connection);
  }

  unregister(deviceId: string): void {
    this.connections.delete(deviceId);
  }

  async routeFromDaemon(connection: Connection, sessionId: string, event: SessionEvent): Promise<void> {
    if (event.type === 'session_started') {
      await this.store.upsertSession({
        id: sessionId,
        userId: connection.userId,
        daemonDeviceId: connection.deviceId,
        projectPath: event.projectPath,
        status: 'running',
        startedAt: event.at,
      });
    } else {
      const status = STATUS_BY_EVENT_TYPE[event.type];
      if (status) {
        await this.store.updateSessionStatus(sessionId, status);
      }
    }
    await this.store.appendSessionEvent(sessionId, event);
    await this.pubsub.publish(CHANNEL, {
      userId: connection.userId,
      message: { kind: 'event', sessionId, event },
    } satisfies PubSubEnvelope);
  }

  async routeFromBrowser(connection: Connection, sessionId: string, command: Command): Promise<void> {
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

  private dispatchLocal(envelope: PubSubEnvelope): void {
    if (envelope.message.kind === 'event') {
      for (const connection of this.connections.values()) {
        if (connection.userId === envelope.userId && connection.deviceType === 'browser') {
          connection.send(envelope.message);
        }
      }
    } else {
      const target = envelope.targetDeviceId ? this.connections.get(envelope.targetDeviceId) : undefined;
      if (target && target.userId === envelope.userId) {
        target.send(envelope.message);
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/hub.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
git add packages/relay/src/hub.ts packages/relay/src/hub.test.ts
git commit -m "feat(relay): add ConnectionHub for event/command routing"
```

---

## Task 6: Relay — HTTP + WebSocket server, entrypoint, README

**Files:**
- Create: `packages/relay/src/server.ts`
- Create: `packages/relay/src/server.test.ts`
- Modify: `packages/relay/src/index.ts`
- Create: `packages/relay/README.md`

**Interfaces:**
- Consumes: `RelayMessage`, `RedeemPairingRequest` (from `@companion/protocol`, Task 2); `Store`, `PubSub` (Task 3); `PairingService` (Task 4); `ConnectionHub`, `Connection` (Task 5).
- Produces: `function createRelayServer(options: { store: Store; pubsub: PubSub }): http.Server`, exposing:
  - `POST /pairing/request-code` → `201 { code, expiresAt }`
  - `POST /pairing/redeem` `{ code, deviceType, deviceName }` → `201 { token, deviceId }` or `400` for an invalid/expired code
  - `GET /sessions/:id` → `200 SessionRecord` or `404`
  - `GET /sessions/:id/events?since=<seq>` → `200 StoredSessionEvent[]`
  - A `/ws` WebSocket endpoint, authenticated via a `?token=` query parameter, that registers the connection with the `ConnectionHub` and relays `RelayMessage`s between the socket and the hub.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay/src/server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('relay server', () => {
  let httpServer: Server;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets = [];
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('pairs a daemon and a browser, then routes an event and a command between them', async () => {
    const store = new InMemoryStore();
    const pubsub = new InMemoryPubSub();
    httpServer = createRelayServer({ store, pubsub });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonCodeRes = await request(httpServer).post('/pairing/request-code').send();
    const daemonRedeemRes = await request(httpServer)
      .post('/pairing/redeem')
      .send({ code: daemonCodeRes.body.code, deviceType: 'daemon', deviceName: 'laptop' });
    const daemonToken = daemonRedeemRes.body.token as string;

    const browserCodeRes = await request(httpServer).post('/pairing/request-code').send();
    const browserRedeemRes = await request(httpServer)
      .post('/pairing/redeem')
      .send({ code: browserCodeRes.body.code, deviceType: 'browser', deviceName: 'phone' });
    const browserToken = browserRedeemRes.body.token as string;

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(daemonWs, browserWs);
    await Promise.all([waitForOpen(daemonWs), waitForOpen(browserWs)]);

    const browserReceived = waitForMessage(browserWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        event: {
          type: 'session_started',
          sessionId: 'sess-1',
          projectPath: '/tmp/project',
          at: Date.now(),
        },
      })
    );
    expect(await browserReceived).toMatchObject({ kind: 'event', sessionId: 'sess-1' });

    const eventsRes = await request(httpServer).get('/sessions/sess-1/events');
    expect(eventsRes.body).toHaveLength(1);

    const sessionRes = await request(httpServer).get('/sessions/sess-1');
    expect(sessionRes.body).toMatchObject({ id: 'sess-1', status: 'running' });

    const daemonReceived = waitForMessage(daemonWs);
    browserWs.send(
      JSON.stringify({ kind: 'command', sessionId: 'sess-1', command: { type: 'pause', sessionId: 'sess-1' } })
    );
    expect(await daemonReceived).toMatchObject({ kind: 'command', sessionId: 'sess-1' });
  });

  it('rejects a WS connection with an invalid token', async () => {
    httpServer = createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
    sockets.push(ws);
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(4401);
  });

  it('returns 400 for an invalid pairing redeem request', async () => {
    httpServer = createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/pairing/redeem').send({ code: '000000' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session id', async () => {
    httpServer = createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd "D:/Companion/.claude/worktrees/relay-server/packages/relay"
npx vitest run src/server.test.ts
```

Expected: FAIL — `./server.js` does not exist.

- [ ] **Step 3: Implement `server.ts`**

Create `packages/relay/src/server.ts`:

```ts
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { RelayMessage, RedeemPairingRequest } from '@companion/protocol';
import type { Store } from './store.js';
import type { PubSub } from './pubsub.js';
import { PairingService } from './pairing.js';
import { ConnectionHub, type Connection } from './hub.js';

function asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export interface RelayServerOptions {
  store: Store;
  pubsub: PubSub;
}

export function createRelayServer({ store, pubsub }: RelayServerOptions): Server {
  const pairing = new PairingService(store);
  const hub = new ConnectionHub(store, pubsub);

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
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const session = await store.getSession(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Unknown session' });
        return;
      }
      res.status(200).json(session);
    })
  );

  app.get(
    '/sessions/:id/events',
    asyncHandler(async (req, res) => {
      const sinceSeq = req.query.since ? Number(req.query.since) : undefined;
      const events = await store.getSessionEvents(req.params.id, sinceSeq);
      res.status(200).json(events);
    })
  );

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    void (async () => {
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
          } catch {
            // Malformed or unauthorized message — silently dropped for v1.
          }
        })();
      });

      ws.on('close', () => hub.unregister(device.id));
    })();
  });

  return httpServer;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/server.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Wire the entrypoint**

Replace `packages/relay/src/index.ts` with:

```ts
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';

const PORT = Number(process.env.COMPANION_RELAY_PORT ?? 8787);
const HOST = process.env.COMPANION_RELAY_HOST ?? '0.0.0.0';

const store = new InMemoryStore();
const pubsub = new InMemoryPubSub();
const httpServer = createRelayServer({ store, pubsub });

httpServer.listen(PORT, HOST, () => {
  console.log(`Companion relay listening on http://${HOST}:${PORT}`);
});
```

- [ ] **Step 6: Write the relay README**

Create `packages/relay/README.md`:

```markdown
# @companion/relay

The hosted relay: pairs daemon and browser devices for a user, and routes
`SessionEvent`s from daemon → browsers and `Command`s from browser → daemon
over WebSocket, persisting both durably.

## Run

    npm run build
    npm start

Set `COMPANION_RELAY_PORT` (default `8787`) and `COMPANION_RELAY_HOST`
(default `0.0.0.0` — unlike the daemon, this server is meant to be
publicly reachable) to configure the listener.

## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /sessions/:id` — current session status (for reconnect/catch-up).
- `GET /sessions/:id/events?since=<seq>` — session event history.

## WebSocket

Connect to `/ws?token=<device-token>`. Daemons send `{kind:'event', ...}`
messages; browsers send `{kind:'command', ...}` messages. The server
routes events to every browser connection for the same user, and commands
to the specific daemon connection that owns the target session.

## Current scope (v1)

- Storage (`Store`) and cross-instance routing (`PubSub`) are in-memory —
  state does not persist across restarts and this process cannot yet be
  horizontally scaled. Both are defined as port interfaces
  (`store.ts`, `pubsub.ts`) specifically so real Postgres/Redis-backed
  implementations can be swapped in later without touching `hub.ts`,
  `pairing.ts`, or `server.ts`.
- A single seeded default user; pairing-code requests are unauthenticated
  (bootstraps the first device). Public multi-user signup is future work.
- Routing a `start_session` command through the relay (remotely starting a
  brand-new session) is not implemented — only commands on an
  already-started session (`inject_prompt`, `respond_to_permission`,
  `pause`, `resume`, `stop`).
- Web Push notification delivery is not implemented — events are stored
  and routed to connected clients only.
```

- [ ] **Step 7: Run the full workspace suite and a clean build**

```bash
cd "D:/Companion/.claude/worktrees/relay-server"
npm test
rm -rf packages/*/dist packages/*/*.tsbuildinfo
npm run build
```

Expected: every package's tests pass — relay: 27 tests (7 store + 4 pubsub + 5 pairing + 7 hub + 4 server); protocol: 11; daemon: unchanged from Plan 1 — and the build succeeds in one shot, protocol → daemon → relay.

- [ ] **Step 8: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts packages/relay/src/index.ts packages/relay/README.md
git commit -m "feat(relay): add HTTP+WebSocket server, entrypoint, and README"
```

---

## Plan-level verification

After Task 6, from the repo root:

```bash
rm -rf packages/*/dist packages/*/*.tsbuildinfo
npm run build
npm test
```

Expected: a clean one-shot build across `protocol` → `daemon` → `relay`, and every package's test suite passing. This confirms Plan 2's deliverable — a standalone, fully-tested relay server that pairs devices and routes events/commands — is ready for a later plan to connect the real daemon (replacing its local-only HTTP control surface with an outbound WebSocket client to this relay) and the mobile web app to.
