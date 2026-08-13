# Multi-User Hosting (Clerk Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the relay's single seeded user with real, per-person Clerk accounts — true public signup, one daemon per account, any number of browsers per account — while keeping every existing route's device-token authentication scheme completely unchanged.

**Architecture:** Clerk touches the system exactly once: a new browser exchanges its Clerk session token for a companion device token at `POST /devices/register-browser`, verified server-side via `@clerk/backend`. Every other route keeps using the existing Bearer-device-token / WS `?token=` scheme untouched. Daemon pairing becomes a real device-authorization handshake (`request-code` → a human claims it from their browser → the daemon polls until claimed) instead of today's unattended one-shot self-pairing.

**Tech Stack:** `@clerk/backend` (relay), `@clerk/clerk-react` (web), existing `drizzle-orm`/`pg` (Neon Postgres), existing `zod`.

## Global Constraints

- Exactly one `daemon` device per account, enforced at `POST /pairing/claim`; any number of `browser` devices per account.
- Clerk is verified exactly once per browser device, at `/devices/register-browser` — never on the ongoing request path. All existing routes, the WS handshake, and `hub.ts` keep using the companion device-token scheme unchanged.
- Pairing codes are single-use end to end: claimable exactly once, pollable/redeemable exactly once after that.
- Device pairings — browser and daemon alike — never expire and are never silently revoked; only an explicit unpair (existing `/devices/unpair`, unchanged) ends one.
- No second daemon per account and no cross-device management UI in this plan — both explicitly deferred.
- No change to `hub.ts`, the WS message protocol, or how daemons report sessions.
- `createdAt`/`expiresAt` stay plain JS numbers (epoch-ms) at every `Store` boundary, matching the existing convention.

---

### Task 1: Protocol schema changes

**Files:**
- Modify: `packages/protocol/src/relay.ts`
- Modify: `packages/protocol/src/relay.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (first task).
- Produces: `RequestPairingCodeRequest`, `ClaimPairingRequest`, `PollPairingRequest`, `RegisterBrowserRequest` Zod schemas + inferred types, exported from `@companion/protocol`. `RedeemPairingRequest` is removed. Consumed by Task 6 (`server.ts`).

- [ ] **Step 1: Replace `RedeemPairingRequest` with the four new request schemas**

In `packages/protocol/src/relay.ts`, replace the `RedeemPairingRequest` export (lines 20-25) with:

```ts
export const RequestPairingCodeRequest = z.object({
  deviceName: z.string(),
});
export type RequestPairingCodeRequest = z.infer<typeof RequestPairingCodeRequest>;

export const ClaimPairingRequest = z.object({
  code: z.string(),
});
export type ClaimPairingRequest = z.infer<typeof ClaimPairingRequest>;

export const PollPairingRequest = z.object({
  deviceCode: z.string(),
});
export type PollPairingRequest = z.infer<typeof PollPairingRequest>;

export const RegisterBrowserRequest = z.object({
  deviceName: z.string(),
});
export type RegisterBrowserRequest = z.infer<typeof RegisterBrowserRequest>;
```

- [ ] **Step 2: Replace the `RedeemPairingRequest` tests**

In `packages/protocol/src/relay.test.ts`, replace the import on line 2 with:

```ts
import { RelayMessage, RequestPairingCodeRequest, ClaimPairingRequest, PollPairingRequest, RegisterBrowserRequest } from './relay.js';
```

Replace the `describe('RedeemPairingRequest schema', ...)` block (lines 39-57) with:

```ts
describe('RequestPairingCodeRequest schema', () => {
  it('accepts a valid request', () => {
    expect(RequestPairingCodeRequest.safeParse({ deviceName: 'my-laptop' }).success).toBe(true);
  });

  it('rejects a missing deviceName', () => {
    expect(RequestPairingCodeRequest.safeParse({}).success).toBe(false);
  });
});

describe('ClaimPairingRequest schema', () => {
  it('accepts a valid request', () => {
    expect(ClaimPairingRequest.safeParse({ code: '123456' }).success).toBe(true);
  });

  it('rejects a missing code', () => {
    expect(ClaimPairingRequest.safeParse({}).success).toBe(false);
  });
});

describe('PollPairingRequest schema', () => {
  it('accepts a valid request', () => {
    expect(PollPairingRequest.safeParse({ deviceCode: 'abc' }).success).toBe(true);
  });

  it('rejects a missing deviceCode', () => {
    expect(PollPairingRequest.safeParse({}).success).toBe(false);
  });
});

describe('RegisterBrowserRequest schema', () => {
  it('accepts a valid request', () => {
    expect(RegisterBrowserRequest.safeParse({ deviceName: 'phone' }).success).toBe(true);
  });

  it('rejects a missing deviceName', () => {
    expect(RegisterBrowserRequest.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run the protocol test suite**

Run (from repo root): `npm test -w @companion/protocol`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/relay.ts packages/protocol/src/relay.test.ts
git commit -m "feat(protocol): replace RedeemPairingRequest with the multi-user pairing/registration schemas"
```

---

### Task 2: Store interface, InMemoryStore, and contract tests

**Files:**
- Modify: `packages/relay/src/store.ts`
- Modify: `packages/relay/src/in-memory-store.ts`
- Modify: `packages/relay/src/store-contract-tests.ts`
- Modify: `packages/relay/src/hub.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Store` interface gains `getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User>`, `createPairingCode(deviceName: string): Promise<PairingCode>`, `claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'>`, `getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined>`, `markPairingCodeRedeemed(deviceCode: string): Promise<void>`, `getDaemonDeviceForUser(userId: string): Promise<Device | undefined>`. `PairingCode` gains `deviceCode: string`, `deviceName: string`, `userId: string | null`, `redeemed: boolean` (replacing `consumed`). `getOrCreateDefaultUser` and `consumePairingCode` are removed. Consumed by Task 3 (`postgres-store.ts`), Task 5 (`pairing.ts`).

- [ ] **Step 1: Update the `Store` interface**

In `packages/relay/src/store.ts`, replace the `PairingCode` interface (lines 19-24) with:

```ts
export interface PairingCode {
  code: string;
  deviceCode: string;
  userId: string | null;
  deviceName: string;
  expiresAt: number;
  redeemed: boolean;
}
```

Replace the `Store` interface (lines 46-67) with:

```ts
export interface Store {
  getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User>;
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
  getDaemonDeviceForUser(userId: string): Promise<Device | undefined>;
  createPairingCode(deviceName: string): Promise<PairingCode>;
  claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'>;
  getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined>;
  markPairingCodeRedeemed(deviceCode: string): Promise<void>;
  upsertSession(session: SessionRecord): Promise<void>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | undefined>;
  getActiveSessionsForUser(userId: string): Promise<SessionRecord[]>;
  dismissSession(sessionId: string, userId: string): Promise<DismissSessionResult>;
  appendSessionEvent(sessionId: string, event: SessionEvent): Promise<StoredSessionEvent>;
  getSessionEvents(sessionId: string, sinceSeq?: number): Promise<StoredSessionEvent[]>;
}
```

- [ ] **Step 2: Update `InMemoryStore`**

In `packages/relay/src/in-memory-store.ts`, replace the field declarations (lines 16-23) with:

```ts
export class InMemoryStore implements Store {
  private users = new Map<string, User>();
  private usersByClerkId = new Map<string, string>();
  private devices = new Map<string, Device>();
  private devicesByTokenHash = new Map<string, string>();
  private pairingCodes = new Map<string, PairingCode>();
  private pairingCodesByDeviceCode = new Map<string, string>();
  private sessions = new Map<string, SessionRecord>();
  private events = new Map<string, StoredSessionEvent[]>();
  private nextSeq = 1;
```

Replace `getOrCreateDefaultUser` (lines 27-35) with:

```ts
  async getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User> {
    const existingId = this.usersByClerkId.get(clerkUserId);
    if (existingId) return this.users.get(existingId)!;
    const user: User = { id: randomUUID(), email, createdAt: this.now() };
    this.users.set(user.id, user);
    this.usersByClerkId.set(clerkUserId, user.id);
    return user;
  }
```

After `getDevicesForUser` (after line 74), add:

```ts

  async getDaemonDeviceForUser(userId: string): Promise<Device | undefined> {
    return [...this.devices.values()].find((d) => d.userId === userId && d.type === 'daemon');
  }
```

Replace `createPairingCode` and `consumePairingCode` (lines 76-95) with:

```ts
  async createPairingCode(deviceName: string): Promise<PairingCode> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const deviceCode = randomUUID();
    const pairing: PairingCode = {
      code,
      deviceCode,
      userId: null,
      deviceName,
      expiresAt: this.now() + PAIRING_CODE_TTL_MS,
      redeemed: false,
    };
    this.pairingCodes.set(code, pairing);
    this.pairingCodesByDeviceCode.set(deviceCode, code);
    return pairing;
  }

  async claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'> {
    const pairing = this.pairingCodes.get(code);
    if (!pairing) return 'not_found';
    if (pairing.expiresAt < this.now()) return 'expired';
    if (pairing.userId) return 'already_claimed';
    pairing.userId = userId;
    return 'ok';
  }

  async getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined> {
    const code = this.pairingCodesByDeviceCode.get(deviceCode);
    return code ? this.pairingCodes.get(code) : undefined;
  }

  async markPairingCodeRedeemed(deviceCode: string): Promise<void> {
    const code = this.pairingCodesByDeviceCode.get(deviceCode);
    if (!code) return;
    const pairing = this.pairingCodes.get(code);
    if (pairing) pairing.redeemed = true;
  }
```

- [ ] **Step 3: Update the shared contract tests**

In `packages/relay/src/store-contract-tests.ts`, every test currently calls `await store.getOrCreateDefaultUser()` to obtain a `user`. Replace every such call with `await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com')` (same variable name `user`, so nothing else in each test body changes). This applies to the tests at (original line numbers): 8-10, 15, 33, 53, 70.

Replace the two pairing-code tests (lines 106-127) with:

```ts
    it('a pairing code can only be claimed once', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      const first = await store.claimPairingCode(pairing.code, 'user-1');
      expect(first).toBe('ok');

      const second = await store.claimPairingCode(pairing.code, 'user-2');
      expect(second).toBe('already_claimed');
    });

    it('claimPairingCode returns not_found for an unknown code', async () => {
      const store = await makeStore();
      expect(await store.claimPairingCode('000000', 'user-1')).toBe('not_found');
    });

    it('claimPairingCode returns expired for an expired code', async () => {
      let now = 1_000_000;
      const store = await makeStore(() => now);
      const pairing = await store.createPairingCode('my-laptop');

      now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute TTL

      expect(await store.claimPairingCode(pairing.code, 'user-1')).toBe('expired');
    });

    it('getPairingCodeByDeviceCode finds the pairing code by its device code', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);

      expect(found?.code).toBe(pairing.code);
      expect(found?.userId).toBeNull();
      expect(found?.redeemed).toBe(false);
    });

    it('getPairingCodeByDeviceCode returns undefined for an unknown device code', async () => {
      const store = await makeStore();
      expect(await store.getPairingCodeByDeviceCode('does-not-exist')).toBeUndefined();
    });

    it('claiming a pairing code is reflected when looked up by device code', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      await store.claimPairingCode(pairing.code, 'user-1');

      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);
      expect(found?.userId).toBe('user-1');
    });

    it('markPairingCodeRedeemed sets redeemed to true', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      await store.markPairingCodeRedeemed(pairing.deviceCode);

      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);
      expect(found?.redeemed).toBe(true);
    });

    it('markPairingCodeRedeemed is a no-op for an unknown device code', async () => {
      const store = await makeStore();
      await expect(store.markPairingCodeRedeemed('does-not-exist')).resolves.toBeUndefined();
    });

    it('getDaemonDeviceForUser returns the daemon device for that user', async () => {
      const store = await makeStore();
      await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-a' });
      const daemon = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-b' });

      const found = await store.getDaemonDeviceForUser('user-1');

      expect(found?.id).toBe(daemon.id);
    });

    it('getDaemonDeviceForUser returns undefined when the user has no daemon device', async () => {
      const store = await makeStore();
      await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-a' });

      expect(await store.getDaemonDeviceForUser('user-1')).toBeUndefined();
    });

    it('getOrCreateUserByClerkId returns the same user on repeated calls with the same clerkUserId', async () => {
      const store = await makeStore();
      const first = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      const second = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      expect(second.id).toBe(first.id);
    });

    it('getOrCreateUserByClerkId creates distinct users for distinct clerkUserIds', async () => {
      const store = await makeStore();
      const first = await store.getOrCreateUserByClerkId('clerk-user-1', 'a@example.com');
      const second = await store.getOrCreateUserByClerkId('clerk-user-2', 'b@example.com');
      expect(second.id).not.toBe(first.id);
    });
```

- [ ] **Step 4: Fix `hub.test.ts`, which used `getOrCreateDefaultUser` purely to obtain a userId**

In `packages/relay/src/hub.test.ts`, every occurrence of:

```ts
    const user = await store.getOrCreateDefaultUser();
```

becomes:

```ts
    const userId = 'user-1';
```

and every subsequent `user.id` in that same test becomes `userId`. There are 10 such occurrences (original lines 637, 669, 691, 712, 732, 761, 784, 806, 836, 859). This is mechanical: `getOrCreateDefaultUser` no longer exists on `Store`, and `hub.ts`'s logic never validates that a `userId` corresponds to a real `users` row (consistent with the schema having no FK constraints), so a plain literal string is a correct, valid replacement with no behavior change.

- [ ] **Step 5: Run the relay test suite (in-memory tests only will pass; `postgres-store.test.ts` will fail to compile until Task 3 — that is expected)**

Run: `npm test -w @companion/relay -- store-contract-tests in-memory-store hub`
Expected: PASS. (Full `npm test -w @companion/relay` will still fail elsewhere until later tasks — don't run the full suite yet.)

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/store.ts packages/relay/src/in-memory-store.ts packages/relay/src/store-contract-tests.ts packages/relay/src/hub.test.ts
git commit -m "feat(relay): move Store to per-account users and a two-step pairing-code lifecycle"
```

---

### Task 3: Schema and PostgresStore

**Files:**
- Modify: `packages/relay/src/db/schema.ts`
- Modify: `packages/relay/src/postgres-store.ts`
- Generate: new file(s) under `packages/relay/drizzle/` (via `drizzle-kit generate`, not hand-written)

**Interfaces:**
- Consumes: `Store`, `PairingCode`, `User` from Task 2.
- Produces: `PostgresStore` satisfying the updated `Store` interface, passing the same `runStoreContractTests` suite from Task 2 against real Postgres.

- [ ] **Step 1: Update the schema**

In `packages/relay/src/db/schema.ts`, replace the `users` table definition with:

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});
```

Replace the `pairingCodes` table definition with:

```ts
export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userId: text('user_id'),
  deviceName: text('device_name').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  redeemed: boolean('redeemed').notNull().default(false),
});
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate -w @companion/relay`
Expected: a new SQL file appears under `packages/relay/drizzle/` altering `users` (add `clerk_user_id`, drop the `email` unique constraint) and `pairing_codes` (add `device_code`, `device_name`, `redeemed`; drop `consumed`; make `user_id` nullable). Inspect the generated SQL to confirm it matches this description before proceeding — `drizzle-kit` sometimes asks interactive questions about column renames vs. drop+add; when prompted whether `pairing_codes.consumed` became `pairing_codes.redeemed` (a rename) vs. two separate column changes, choose to drop `consumed` and add `redeemed` as new (they have different semantics now, per the design spec — this is not a rename).

- [ ] **Step 3: Update `PostgresStore`**

In `packages/relay/src/postgres-store.ts`, remove the `DEFAULT_USER_EMAIL` constant. Add `isNull` to the drizzle-orm import on line 2, making it:

```ts
import { and, asc, eq, gt, gte, isNull, lt } from 'drizzle-orm';
```

Replace `getOrCreateDefaultUser` (lines 17-24) with:

```ts
  async getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User> {
    const [user] = await this.db
      .insert(users)
      .values({ clerkUserId, email, createdAt: this.now() })
      .onConflictDoUpdate({ target: users.clerkUserId, set: { email } })
      .returning();
    return user;
  }
```

After `getDevicesForUser` (after line 64), add:

```ts

  async getDaemonDeviceForUser(userId: string): Promise<Device | undefined> {
    const [device] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.type, 'daemon')));
    if (!device) return undefined;
    return { ...device, pushSubscription: device.pushSubscription ?? undefined };
  }
```

Replace `createPairingCode` and `consumePairingCode` (lines 66-87) with:

```ts
  async createPairingCode(deviceName: string): Promise<PairingCode> {
    // Expired codes are never otherwise deleted; sweep them here so this
    // table doesn't grow forever now that storage is durable across restarts.
    await this.db.delete(pairingCodes).where(lt(pairingCodes.expiresAt, this.now()));
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const deviceCode = randomUUID();
    const [pairing] = await this.db
      .insert(pairingCodes)
      .values({
        code,
        deviceCode,
        userId: null,
        deviceName,
        expiresAt: this.now() + PAIRING_CODE_TTL_MS,
        redeemed: false,
      })
      .returning();
    return pairing;
  }

  async claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'> {
    // A single conditional UPDATE is the atomic success path — it only
    // matches (and claims) a row that is unexpired and not yet claimed.
    // The SELECT below only runs to classify *why* it didn't match, for a
    // precise result; it never decides the outcome itself.
    const [claimed] = await this.db
      .update(pairingCodes)
      .set({ userId })
      .where(
        and(eq(pairingCodes.code, code), isNull(pairingCodes.userId), gte(pairingCodes.expiresAt, this.now()))
      )
      .returning();
    if (claimed) return 'ok';

    const [pairing] = await this.db.select().from(pairingCodes).where(eq(pairingCodes.code, code));
    if (!pairing) return 'not_found';
    if (pairing.expiresAt < this.now()) return 'expired';
    return 'already_claimed';
  }

  async getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined> {
    const [pairing] = await this.db.select().from(pairingCodes).where(eq(pairingCodes.deviceCode, deviceCode));
    return pairing;
  }

  async markPairingCodeRedeemed(deviceCode: string): Promise<void> {
    await this.db.update(pairingCodes).set({ redeemed: true }).where(eq(pairingCodes.deviceCode, deviceCode));
  }
```

Add `randomUUID` to the `node:crypto` import at the top of the file, making it:

```ts
import { randomInt, randomUUID } from 'node:crypto';
```

- [ ] **Step 4: Run the full relay test suite, including Postgres**

Run: `npm test -w @companion/relay`
Expected: PASS (this runs `store-contract-tests.ts` against both `InMemoryStore` and `PostgresStore` — the second one hits the real Neon database configured in `packages/relay/.env`).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/db/schema.ts packages/relay/src/postgres-store.ts packages/relay/drizzle/
git commit -m "feat(relay): add Clerk-keyed users and two-step pairing codes to the Postgres schema"
```

---

### Task 4: Identity verification boundary

**Files:**
- Create: `packages/relay/src/identity-verifier.ts`
- Create: `packages/relay/src/identity-verifier.test.ts`
- Modify: `packages/relay/src/index.ts`
- Modify: `packages/relay/package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `IdentityVerifier` interface, `FakeIdentityVerifier` (test double), `ClerkIdentityVerifier` (production implementation), all exported from `@companion/relay`. Consumed by Task 6 (`server.ts`), Task 7 (`main.ts`), Task 8 (`relay-integration.test.ts`).

- [ ] **Step 1: Add the `@clerk/backend` dependency**

In `packages/relay/package.json`, add to `dependencies`:

```json
    "@clerk/backend": "^2.16.5",
```

Run from the repo root: `npm install`

- [ ] **Step 2: Write the interface and the two implementations**

Create `packages/relay/src/identity-verifier.ts`:

```ts
import { createClerkClient, verifyToken } from '@clerk/backend';

export interface VerifiedIdentity {
  clerkUserId: string;
  email: string;
}

export interface IdentityVerifier {
  verifyToken(clerkToken: string): Promise<VerifiedIdentity | undefined>;
}

/**
 * Test double: a fixed map from token string to the identity it represents,
 * with no real Clerk calls. Used by every test that needs an authenticated
 * browser without depending on a live Clerk project.
 */
export class FakeIdentityVerifier implements IdentityVerifier {
  constructor(private identities: Map<string, VerifiedIdentity>) {}

  async verifyToken(clerkToken: string): Promise<VerifiedIdentity | undefined> {
    return this.identities.get(clerkToken);
  }
}

/**
 * Verifies a Clerk session token's signature, then fetches the user's
 * primary email via the Backend API — the default Clerk session token
 * claims don't include email unless the dashboard's session-token template
 * is customized, and requiring every deployment to remember that manual
 * dashboard step is a footgun. This is a one-time call at browser
 * registration, not on the hot request path, so the extra round trip costs
 * nothing that matters.
 */
export class ClerkIdentityVerifier implements IdentityVerifier {
  private client: ReturnType<typeof createClerkClient>;

  constructor(private secretKey: string) {
    this.client = createClerkClient({ secretKey });
  }

  async verifyToken(clerkToken: string): Promise<VerifiedIdentity | undefined> {
    let clerkUserId: string;
    try {
      const claims = await verifyToken(clerkToken, { secretKey: this.secretKey });
      clerkUserId = claims.sub;
    } catch {
      return undefined;
    }
    const user = await this.client.users.getUser(clerkUserId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    return { clerkUserId, email: primary?.emailAddress ?? '' };
  }
}
```

- [ ] **Step 3: Write tests for `FakeIdentityVerifier`**

Create `packages/relay/src/identity-verifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FakeIdentityVerifier } from './identity-verifier.js';

describe('FakeIdentityVerifier', () => {
  it('returns the identity for a known token', async () => {
    const verifier = new FakeIdentityVerifier(
      new Map([['tok-1', { clerkUserId: 'clerk-user-1', email: 'a@example.com' }]])
    );
    expect(await verifier.verifyToken('tok-1')).toEqual({ clerkUserId: 'clerk-user-1', email: 'a@example.com' });
  });

  it('returns undefined for an unknown token', async () => {
    const verifier = new FakeIdentityVerifier(new Map());
    expect(await verifier.verifyToken('nope')).toBeUndefined();
  });
});
```

`ClerkIdentityVerifier` is not unit-tested here — it is a thin wrapper over `@clerk/backend`, whose own SDK is not re-tested by this project (the same reasoning `WebPushSender`'s thin `web-push` wrapper already follows).

- [ ] **Step 4: Export the new symbols from the package**

In `packages/relay/src/index.ts`, add:

```ts
export type { IdentityVerifier, VerifiedIdentity } from './identity-verifier.js';
export { FakeIdentityVerifier, ClerkIdentityVerifier } from './identity-verifier.js';
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @companion/relay -- identity-verifier`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/identity-verifier.ts packages/relay/src/identity-verifier.test.ts packages/relay/src/index.ts packages/relay/package.json package-lock.json
git commit -m "feat(relay): add the Clerk identity-verification boundary"
```

---

### Task 5: PairingService rewrite

**Files:**
- Modify: `packages/relay/src/pairing.ts`
- Modify: `packages/relay/src/pairing.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2).
- Produces: `PairingService` with `requestPairingCode(deviceName: string): Promise<{ code: string; deviceCode: string; expiresAt: number }>`, `claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed' | 'daemon_exists'>`, `pollPairingCode(deviceCode: string): Promise<{ status: 'pending' } | { status: 'expired' } | { status: 'complete'; token: string; deviceId: string }>`, `registerBrowserDevice(userId: string, deviceName: string): Promise<{ token: string; device: Device }>`, `verifyToken(token: string): Promise<Device | undefined>` (unchanged). `redeemPairingCode` is removed. Consumed by Task 6 (`server.ts`).

- [ ] **Step 1: Rewrite `pairing.ts`**

Replace the full contents of `packages/relay/src/pairing.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Device, Store } from './store.js';

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ClaimResult = 'ok' | 'not_found' | 'expired' | 'already_claimed' | 'daemon_exists';
export type PollResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'complete'; token: string; deviceId: string };

export class PairingService {
  constructor(private store: Store) {}

  async requestPairingCode(deviceName: string): Promise<{ code: string; deviceCode: string; expiresAt: number }> {
    const pairing = await this.store.createPairingCode(deviceName);
    return { code: pairing.code, deviceCode: pairing.deviceCode, expiresAt: pairing.expiresAt };
  }

  /** Called by an already-paired browser to link a daemon's pending pairing code to its account. */
  async claimPairingCode(code: string, userId: string): Promise<ClaimResult> {
    const existingDaemon = await this.store.getDaemonDeviceForUser(userId);
    if (existingDaemon) return 'daemon_exists';
    return this.store.claimPairingCode(code, userId);
  }

  /** Called by the daemon that requested the code, until a browser claims it. */
  async pollPairingCode(deviceCode: string): Promise<PollResult> {
    const pairing = await this.store.getPairingCodeByDeviceCode(deviceCode);
    if (!pairing || pairing.redeemed || pairing.expiresAt < Date.now()) {
      return { status: 'expired' };
    }
    if (!pairing.userId) {
      return { status: 'pending' };
    }
    const { token, device } = await this.mintDeviceToken(pairing.userId, 'daemon', pairing.deviceName);
    await this.store.markPairingCodeRedeemed(deviceCode);
    return { status: 'complete', token, deviceId: device.id };
  }

  /** Called once per browser, immediately after Clerk verification succeeds. */
  async registerBrowserDevice(userId: string, deviceName: string): Promise<{ token: string; device: Device }> {
    return this.mintDeviceToken(userId, 'browser', deviceName);
  }

  async verifyToken(token: string): Promise<Device | undefined> {
    return this.store.getDeviceByTokenHash(hashToken(token));
  }

  private async mintDeviceToken(
    userId: string,
    type: 'daemon' | 'browser',
    name: string
  ): Promise<{ token: string; device: Device }> {
    const token = generateToken();
    const device = await this.store.createDevice({ userId, type, name, tokenHash: hashToken(token) });
    return { token, device };
  }
}
```

- [ ] **Step 2: Rewrite `pairing.test.ts`**

Replace the full contents of `packages/relay/src/pairing.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PairingService } from './pairing.js';
import { InMemoryStore } from './in-memory-store.js';

describe('PairingService', () => {
  it('a daemon requests a code, a browser claims it, and the daemon polls it to completion', async () => {
    const pairing = new PairingService(new InMemoryStore());

    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('ok');

    const result = await pairing.pollPairingCode(deviceCode);
    expect(result.status).toBe('complete');
    if (result.status === 'complete') {
      expect(typeof result.token).toBe('string');
      expect(result.token.length).toBeGreaterThan(0);
      const device = await pairing.verifyToken(result.token);
      expect(device?.type).toBe('daemon');
      expect(device?.name).toBe('my-laptop');
      expect(device?.userId).toBe('user-1');
    }
  });

  it('polling before the code is claimed returns pending', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { deviceCode } = await pairing.requestPairingCode('my-laptop');

    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'pending' });
  });

  it('claiming an unknown code returns not_found', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.claimPairingCode('000000', 'user-1')).toBe('not_found');
  });

  it('a code cannot be claimed twice', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code } = await pairing.requestPairingCode('my-laptop');

    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('ok');
    expect(await pairing.claimPairingCode(code, 'user-2')).toBe('already_claimed');
  });

  it('claiming a code is rejected when the account already has a daemon device', async () => {
    const store = new InMemoryStore();
    const pairing = new PairingService(store);
    await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'existing', tokenHash: 'hash-1' });

    const { code } = await pairing.requestPairingCode('new-laptop');

    expect(await pairing.claimPairingCode(code, 'user-1')).toBe('daemon_exists');
  });

  it('polling an unknown device code returns expired', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.pollPairingCode('not-a-real-device-code')).toEqual({ status: 'expired' });
  });

  it('polling again after completion returns expired, not a second token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const { code, deviceCode } = await pairing.requestPairingCode('my-laptop');
    await pairing.claimPairingCode(code, 'user-1');
    await pairing.pollPairingCode(deviceCode);

    expect(await pairing.pollPairingCode(deviceCode)).toEqual({ status: 'expired' });
  });

  it('registerBrowserDevice mints a browser device token for the given user', async () => {
    const pairing = new PairingService(new InMemoryStore());
    const result = await pairing.registerBrowserDevice('user-1', 'phone');

    expect(result.device.type).toBe('browser');
    expect(result.device.name).toBe('phone');
    expect(result.device.userId).toBe('user-1');
    const found = await pairing.verifyToken(result.token);
    expect(found?.id).toBe(result.device.id);
  });

  it('verifyToken returns undefined for a bogus token', async () => {
    const pairing = new PairingService(new InMemoryStore());
    expect(await pairing.verifyToken('not-a-real-token')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test -w @companion/relay -- pairing`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/pairing.ts packages/relay/src/pairing.test.ts
git commit -m "feat(relay): rewrite PairingService around claim/poll instead of one-shot redeem"
```

---

### Task 6: Relay routes and README

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`
- Modify: `packages/relay/README.md`

**Interfaces:**
- Consumes: `PairingService` (Task 5), `IdentityVerifier`/`FakeIdentityVerifier` (Task 4).
- Produces: `RelayServerOptions` gains a required `identityVerifier: IdentityVerifier` field. New routes `POST /pairing/claim`, `POST /pairing/poll`, `POST /devices/register-browser`. `POST /pairing/redeem` is removed. Consumed by Task 7 (`main.ts`), Task 8 (`relay-integration.test.ts`).

- [ ] **Step 1: Update `server.ts`**

In `packages/relay/src/server.ts`, update the imports (lines 4-10) to:

```ts
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import {
  RelayMessage,
  RequestPairingCodeRequest,
  ClaimPairingRequest,
  PollPairingRequest,
  RegisterBrowserRequest,
  PushSubscriptionPayload,
} from '@companion/protocol';
import { ZodError } from 'zod';
import type { Device, Store } from './store.js';
import type { PubSub } from './pubsub.js';
import type { IdentityVerifier } from './identity-verifier.js';
import { PairingService } from './pairing.js';
import { ConnectionHub, type Connection } from './hub.js';
import type { PushSender } from './push-sender.js';
```

Add `identityVerifier` to `RelayServerOptions` (lines 30-35):

```ts
export interface RelayServerOptions {
  store: Store;
  pubsub: PubSub;
  identityVerifier: IdentityVerifier;
  pushSender?: PushSender;
  vapidPublicKey?: string;
}
```

Update the destructuring in `createRelayServer` (line 37):

```ts
export async function createRelayServer({
  store,
  pubsub,
  identityVerifier,
  pushSender,
  vapidPublicKey,
}: RelayServerOptions): Promise<Server> {
```

Replace the `/pairing/request-code` and `/pairing/redeem` routes (lines 45-64) with:

```ts
  app.post(
    '/pairing/request-code',
    asyncHandler(async (req, res) => {
      const { deviceName } = RequestPairingCodeRequest.parse(req.body);
      const result = await pairing.requestPairingCode(deviceName);
      res.status(201).json(result);
    })
  );

  app.post(
    '/pairing/claim',
    asyncHandler(async (req, res) => {
      const device = await authenticate(req, pairing);
      if (!device) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { code } = ClaimPairingRequest.parse(req.body);
      const result = await pairing.claimPairingCode(code, device.userId);
      if (result === 'not_found') {
        res.status(404).json({ error: 'Invalid pairing code' });
        return;
      }
      if (result === 'expired') {
        res.status(410).json({ error: 'Pairing code expired' });
        return;
      }
      if (result === 'already_claimed') {
        res.status(409).json({ error: 'Pairing code already claimed' });
        return;
      }
      if (result === 'daemon_exists') {
        res.status(409).json({ error: 'Account already has a paired daemon — unpair it first' });
        return;
      }
      res.status(200).json({ ok: true });
    })
  );

  app.post(
    '/pairing/poll',
    asyncHandler(async (req, res) => {
      const { deviceCode } = PollPairingRequest.parse(req.body);
      const result = await pairing.pollPairingCode(deviceCode);
      res.status(200).json(result);
    })
  );

  app.post(
    '/devices/register-browser',
    asyncHandler(async (req, res) => {
      const header = req.header('authorization');
      const [scheme, clerkToken] = header?.split(' ') ?? [];
      if (!clerkToken || scheme.toLowerCase() !== 'bearer') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const identity = await identityVerifier.verifyToken(clerkToken);
      if (!identity) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { deviceName } = RegisterBrowserRequest.parse(req.body);
      const user = await store.getOrCreateUserByClerkId(identity.clerkUserId, identity.email);
      const result = await pairing.registerBrowserDevice(user.id, deviceName);
      res.status(201).json({ token: result.token, deviceId: result.device.id });
    })
  );
```

- [ ] **Step 2: Run the type checker to confirm nothing else references the removed route or `getOrCreateDefaultUser`**

Run: `npm run build -w @companion/relay`
Expected: fails only in `server.test.ts` (Step 3 fixes it).

- [ ] **Step 3: Replace `server.test.ts` in full**

Replace the full contents of `packages/relay/src/server.test.ts`:

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
import { FakeIdentityVerifier } from './identity-verifier.js';
import type { PushSender } from './push-sender.js';

function waitForMessage(ws: WebSocket): Promise<any> {
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

const FAKE_CLERK_TOKEN = 'fake-clerk-token';

function makeIdentityVerifier(): FakeIdentityVerifier {
  return new FakeIdentityVerifier(
    new Map([[FAKE_CLERK_TOKEN, { clerkUserId: 'clerk-user-1', email: 'test@example.com' }]])
  );
}

/** Registers a browser device via the Clerk-authenticated registration route. */
async function registerBrowser(httpServer: Server, deviceName: string): Promise<string> {
  const res = await request(httpServer)
    .post('/devices/register-browser')
    .set('Authorization', `Bearer ${FAKE_CLERK_TOKEN}`)
    .send({ deviceName });
  return res.body.token as string;
}

/** Runs the daemon pairing handshake (request-code -> claim by browserToken -> poll) and returns the daemon's token. */
async function pairDaemon(httpServer: Server, browserToken: string, deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName });
  await request(httpServer)
    .post('/pairing/claim')
    .set('Authorization', `Bearer ${browserToken}`)
    .send({ code: codeRes.body.code });
  const pollRes = await request(httpServer).post('/pairing/poll').send({ deviceCode: codeRes.body.deviceCode });
  return pollRes.body.token as string;
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
    httpServer = await createRelayServer({ store, pubsub, identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(daemonWs, browserWs);
    await Promise.all([waitForOpen(daemonWs), waitForOpen(browserWs)]);

    const browserReceived = waitForMessage(browserWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        // The relay assigns the authoritative seq; the inbound value is ignored.
        seq: 0,
        event: {
          type: 'session_started',
          sessionId: 'sess-1',
          projectPath: '/tmp/project',
          at: Date.now(),
        },
      })
    );
    const forwarded = await browserReceived;
    expect(forwarded).toMatchObject({ kind: 'event', sessionId: 'sess-1', seq: 1 });

    const eventsRes = await request(httpServer)
      .get('/sessions/sess-1/events')
      .set('Authorization', `Bearer ${browserToken}`);
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.body).toHaveLength(1);
    expect(eventsRes.body[0].seq).toBe(forwarded.seq);

    const sessionRes = await request(httpServer)
      .get('/sessions/sess-1')
      .set('Authorization', `Bearer ${daemonToken}`);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body).toMatchObject({ id: 'sess-1', status: 'running' });

    const daemonReceived = waitForMessage(daemonWs);
    browserWs.send(
      JSON.stringify({ kind: 'command', sessionId: 'sess-1', command: { type: 'pause', sessionId: 'sess-1' } })
    );
    expect(await daemonReceived).toMatchObject({ kind: 'command', sessionId: 'sess-1' });
  });

  it('rejects a WS connection with an invalid token', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
    sockets.push(ws);
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(4401);
  });

  it('returns 400 for a malformed /pairing/claim request body', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session id when authenticated', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer).get('/sessions/does-not-exist').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('closes WS connection cleanly if Store.getDeviceByTokenHash throws', async () => {
    const baseStore = new InMemoryStore();
    const pubsub = new InMemoryPubSub();

    // Create a wrapper store that throws on getDeviceByTokenHash.
    const throwingStore = Object.create(baseStore) as typeof baseStore;
    throwingStore.getDeviceByTokenHash = async () => {
      throw new Error('Store connection failed');
    };

    httpServer = await createRelayServer({ store: throwingStore, pubsub, identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=any-token`);
    sockets.push(ws);

    // Wait for the connection to close. The close code should be 1011 (internal error),
    // and the entire relay process should still be running (not crashed).
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(1011);

    // Verify the relay is still responsive by making an HTTP request.
    const res = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'x' });
    expect(res.status).toBe(201);
  });

  // --- C1: a malformed WebSocket frame must not crash the process ---

  // FIN=1, RSV1=1 (illegal without a negotiated extension), opcode=1 (text); MASK=1, len=0; 4 mask bytes.
  const MALFORMED_FRAME = Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]);

  it('survives a malformed WebSocket frame instead of crashing the process', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // A tokenless handshake still reaches the frame parser, so this is exploitable pre-auth.
    const anonWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(anonWs);
    anonWs.on('error', () => {});
    await new Promise<void>((resolve) => anonWs.once('upgrade', () => resolve()));
    (anonWs as unknown as { _socket: Socket })._socket.write(MALFORMED_FRAME);

    // And the same frame on a fully established, authenticated connection.
    const browserToken = await registerBrowser(httpServer, 'phone');
    const token = await pairDaemon(httpServer, browserToken, 'laptop');
    const authedWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(authedWs);
    authedWs.on('error', () => {});
    await waitForOpen(authedWs);
    (authedWs as unknown as { _socket: Socket })._socket.write(MALFORMED_FRAME);
    await new Promise<void>((resolve) => authedWs.once('close', () => resolve()));

    // The process must still be alive and serving.
    const res = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'x' });
    expect(res.status).toBe(201);
  });

  // --- C3: REST session routes require authentication and ownership ---

  it('returns 401 for GET /sessions/:id and /events without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    expect((await request(httpServer).get('/sessions/sess-1')).status).toBe(401);
    expect((await request(httpServer).get('/sessions/sess-1/events')).status).toBe(401);
  });

  it('returns 401 for a malformed or unknown bearer token', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    expect((await request(httpServer).get('/sessions/sess-1').set('Authorization', 'nonsense')).status).toBe(401);
    expect(
      (await request(httpServer).get('/sessions/sess-1').set('Authorization', 'Bearer bogus')).status
    ).toBe(401);
  });

  it("returns 404 (not 403) when a device from another user asks for a session it doesn't own", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');
    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/secret', at: Date.now() },
      })
    );
    // Wait until the session record exists.
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    // A device belonging to a completely different user.
    const intruderToken = 'intruder-token';
    await store.createDevice({
      userId: 'some-other-user',
      type: 'browser',
      name: 'attacker',
      tokenHash: createHash('sha256').update(intruderToken).digest('hex'),
    });

    const sessionRes = await request(httpServer)
      .get('/sessions/sess-1')
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(sessionRes.status).toBe(404);
    expect(sessionRes.body).toEqual({ error: 'Unknown session' });

    const eventsRes = await request(httpServer)
      .get('/sessions/sess-1/events')
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(eventsRes.status).toBe(404);
  });

  // --- diagnostic error frame instead of silent drop ---

  it('replies with a diagnostic error frame when a routed message is rejected', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(browserWs);
    await waitForOpen(browserWs);

    const received = waitForMessage(browserWs);
    browserWs.send(
      JSON.stringify({
        kind: 'command',
        sessionId: 'nope',
        command: { type: 'pause', sessionId: 'nope' },
      })
    );
    expect(await received).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown session') });
  });

  // --- GET /sessions/active ---

  it("returns the authenticated device's active sessions", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 for GET /sessions/active without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/active');
    expect(res.status).toBe(401);
  });

  // --- POST /sessions/:id/dismiss ---

  it('dismisses a stopped session and removes it from the active list', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    // Wait for session_started to land before sending stopped: both events are handled by
    // detached async tasks per WS message, so without this the stopped handler's ownership
    // check can run before upsertSession completes and the event gets dropped as "unknown session".
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.status, { timeout: 2000 })
      .toBe('running');
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
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer)
      .post('/sessions/does-not-exist/dismiss')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 401 for POST /sessions/:id/dismiss without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/sessions/sess-1/dismiss');
    expect(res.status).toBe(401);
  });

  // --- GET /devices/me ---

  it("returns the authenticated device's own info", async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'browser', name: 'phone' });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(Number));
    expect(res.body).not.toHaveProperty('tokenHash');
    expect(res.body).not.toHaveProperty('userId');
  });

  it('returns 401 for GET /devices/me without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/devices/me');
    expect(res.status).toBe(401);
  });

  // --- POST /devices/unpair ---

  it('unpairs the device: the endpoint succeeds and the token stops authenticating', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');

    const unpairRes = await request(httpServer).post('/devices/unpair').set('Authorization', `Bearer ${token}`);
    expect(unpairRes.status).toBe(200);
    expect(unpairRes.body).toEqual({ ok: true });

    const followUp = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);
    expect(followUp.status).toBe(401);
  });

  it('returns 401 for POST /devices/unpair without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/devices/unpair');
    expect(res.status).toBe(401);
  });

  it('force-closes every other live connection authenticated as the unpaired device', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const token = await registerBrowser(httpServer, 'phone');

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

  // --- push notifications ---

  it('returns 404 for GET /push/vapid-public-key when push is not configured', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(404);
  });

  it('returns the configured VAPID public key', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      vapidPublicKey: 'test-public-key',
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: 'test-public-key' });
  });

  it('returns 401 for POST /devices/push-subscription without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/devices/push-subscription')
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(401);
  });

  it('returns 400 for POST /devices/push-subscription with an invalid subscription body', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
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
    httpServer = await createRelayServer({
      store,
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      pushSender,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).delete('/devices/push-subscription');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 4: Update the README**

In `packages/relay/README.md`, replace lines 52-55:

```markdown
- `POST /pairing/request-code` `{ deviceName }` — a daemon requests a
  6-digit, 5-minute, single-use pairing code, plus a private `deviceCode`
  it uses to poll for completion. The code is not yet linked to any
  account.
- `POST /pairing/claim` `{ code }` — an already-authenticated browser
  device links a pending pairing code to its own account. `409` if that
  account already has a paired daemon device.
- `POST /pairing/poll` `{ deviceCode }` — the daemon that requested the
  code polls this until a browser claims it, then receives its device
  token. Always `200`, with `{ status: 'pending' | 'expired' }` or
  `{ status: 'complete', token, deviceId }`.
- `POST /devices/register-browser` `{ deviceName }`, authenticated with a
  Clerk session token (not a device token) — exchanges Clerk identity for
  this browser's own long-lived companion device token. Called once per
  browser, the first time it signs in.
```

And update line 122 (the deploy-notes list mentioning the single seeded user):

```markdown
- Real per-account isolation via Clerk — see
  `docs/superpowers/specs/2026-08-11-multi-user-hosting-design.md`.
```

- [ ] **Step 5: Run the full relay test suite**

Run: `npm test -w @companion/relay`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts packages/relay/README.md
git commit -m "feat(relay): add claim/poll/register-browser routes, retire /pairing/redeem"
```

---

### Task 7: Relay startup wiring

**Files:**
- Modify: `packages/relay/src/main.ts`
- Modify: `packages/relay/.env.example`

**Interfaces:**
- Consumes: `ClerkIdentityVerifier` (Task 4), `RelayServerOptions.identityVerifier` (Task 6).
- Produces: nothing new consumed by later tasks — this is the runtime entry point.

- [ ] **Step 1: Wire `CLERK_SECRET_KEY` into `main.ts`**

In `packages/relay/src/main.ts`, add the import:

```ts
import { ClerkIdentityVerifier } from './identity-verifier.js';
```

After the `DATABASE_URL` check (after line 30), add:

```ts

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) {
  throw new Error(
    'CLERK_SECRET_KEY is required — set it to your Clerk application\'s secret key. ' +
      'See packages/relay/.env.example for local development.'
  );
}
```

Add the verifier construction near where `store` is constructed (after line 51):

```ts
const identityVerifier = new ClerkIdentityVerifier(CLERK_SECRET_KEY);
```

Update the `createRelayServer` call (lines 53-58) to include it:

```ts
const httpServer = await createRelayServer({
  store,
  pubsub,
  identityVerifier,
  pushSender,
  vapidPublicKey: pushSender ? vapidPublicKey : undefined,
});
```

- [ ] **Step 2: Document the new env var**

In `packages/relay/.env.example`, add:

```
CLERK_SECRET_KEY=sk_test_...
```

- [ ] **Step 3: Confirm the relay builds**

Run: `npm run build -w @companion/relay`
Expected: succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/main.ts packages/relay/.env.example
git commit -m "feat(relay): require CLERK_SECRET_KEY and wire ClerkIdentityVerifier into startup"
```

---

### Task 8: Daemon pairing handshake

**Files:**
- Modify: `packages/daemon/src/device-auth.ts`
- Modify: `packages/daemon/src/device-auth.test.ts`
- Modify: `packages/daemon/src/relay-integration.test.ts`

**Interfaces:**
- Consumes: the new `/pairing/request-code` and `/pairing/poll` response shapes (Task 6), `FakeIdentityVerifier` (Task 4, via `@companion/relay`).
- Produces: `getOrCreateDeviceToken` behavior change only — its exported signature is unchanged.

- [ ] **Step 1: Rewrite `pairNewDevice` to poll instead of redeem**

In `packages/daemon/src/device-auth.ts`, replace the doc comment above `getOrCreateDeviceToken` (lines 23-31) with:

```ts
/**
 * Returns this daemon's device credentials, reading them from `tokenPath` if
 * present. On first run (no token file yet), requests a pairing code from
 * the relay, prints it for a human to enter in their already-authenticated
 * Companion web app, then polls until that claim completes and the relay
 * mints this daemon's device token.
 */
```

Replace `pairNewDevice` (lines 57-81) with:

```ts
export const POLL_INTERVAL_MS = 2000;

async function pairNewDevice(
  relayHttpUrl: string,
  deviceName: string,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  // Strip a trailing slash the same way relay-client.ts does, so a
  // COMPANION_RELAY_URL like `ws://host:8787/` cannot produce `...//request-code`.
  const base = relayHttpUrl.replace(/\/$/, '');
  const codeRes = await fetchFn(`${base}/pairing/request-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceName }),
  });
  if (!codeRes.ok) {
    throw new Error(`Failed to request a pairing code from the relay: HTTP ${codeRes.status}`);
  }
  const { code, deviceCode, expiresAt } = (await codeRes.json()) as {
    code: string;
    deviceCode: string;
    expiresAt: number;
  };

  console.log(`Pairing code: ${code}`);
  console.log('Enter this code in the Companion web app to link this daemon to your account.');

  return pollForToken(base, deviceCode, expiresAt, fetchFn);
}

async function pollForToken(
  base: string,
  deviceCode: string,
  expiresAt: number,
  fetchFn: FetchLike
): Promise<DeviceCredentials> {
  while (Date.now() < expiresAt) {
    const pollRes = await fetchFn(`${base}/pairing/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    });
    if (!pollRes.ok) {
      throw new Error(`Failed to poll pairing status: HTTP ${pollRes.status}`);
    }
    const result = (await pollRes.json()) as
      | { status: 'pending' }
      | { status: 'expired' }
      | { status: 'complete'; token: string; deviceId: string };
    if (result.status === 'complete') {
      return { token: result.token, deviceId: result.deviceId };
    }
    if (result.status === 'expired') {
      throw new Error('Pairing code expired before it was claimed');
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Pairing code expired before it was claimed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Rewrite `device-auth.test.ts`**

Replace the full contents of `packages/daemon/src/device-auth.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateDeviceToken, POLL_INTERVAL_MS, type FetchLike } from './device-auth.js';

describe('getOrCreateDeviceToken', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('requests a code and persists the token once the first poll reports complete', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'nested', 'device.json');
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push(url);
      if (url.endsWith('/pairing/request-code')) {
        expect(JSON.parse(init!.body!)).toEqual({ deviceName: 'laptop' });
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      if (url.endsWith('/pairing/poll')) {
        expect(JSON.parse(init!.body!)).toEqual({ deviceCode: 'devcode-1' });
        return { ok: true, status: 200, json: async () => ({ status: 'complete', token: 'secret-token', deviceId: 'device-1' }) };
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
    expect(calls).toEqual(['http://localhost:8787/pairing/request-code', 'http://localhost:8787/pairing/poll']);

    const persisted = JSON.parse(await readFile(tokenPath, 'utf8'));
    expect(persisted).toEqual({ token: 'secret-token', deviceId: 'device-1' });
  });

  it('keeps polling while pending, then returns once claimed', async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    let pollCount = 0;
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith('/pairing/request-code')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      pollCount++;
      if (pollCount < 3) {
        return { ok: true, status: 200, json: async () => ({ status: 'pending' }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', token: 'secret-token', deviceId: 'device-1' }) };
    };

    const promise = getOrCreateDeviceToken({
      relayHttpUrl: 'http://x',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(await promise).toEqual({ token: 'secret-token', deviceId: 'device-1' });
    expect(pollCount).toBe(3);
  });

  it('throws when the pairing code expires before being claimed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    const fetchFn: FetchLike = async (url) => {
      if (url.endsWith('/pairing/request-code')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'expired' }) };
    };

    await expect(
      getOrCreateDeviceToken({ relayHttpUrl: 'http://x', deviceName: 'laptop', tokenPath, fetchFn })
    ).rejects.toThrow('Pairing code expired');
  });

  it('does not double up the slash when relayHttpUrl has a trailing slash', async () => {
    dir = await mkdtemp(join(tmpdir(), 'companion-device-'));
    const tokenPath = join(dir, 'device.json');
    const calls: string[] = [];
    const fetchFn: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith('/pairing/request-code')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: '123456', deviceCode: 'devcode-1', expiresAt: Date.now() + 60_000 }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'complete', token: 'secret-token', deviceId: 'device-1' }) };
    };

    await getOrCreateDeviceToken({
      relayHttpUrl: 'http://x/',
      deviceName: 'laptop',
      tokenPath,
      fetchFn,
    });

    expect(calls).toEqual(['http://x/pairing/request-code', 'http://x/pairing/poll']);
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

- [ ] **Step 3: Update `relay-integration.test.ts`**

In `packages/daemon/src/relay-integration.test.ts`, update the import on line 6 to:

```ts
import { createRelayServer, InMemoryStore, InMemoryPubSub, FakeIdentityVerifier } from '@companion/relay';
```

Replace the `pair` helper (lines 10-16) with:

```ts
const FAKE_CLERK_TOKEN = 'fake-clerk-token';

async function registerBrowser(httpServer: Server, deviceName: string): Promise<string> {
  const res = await request(httpServer)
    .post('/devices/register-browser')
    .set('Authorization', `Bearer ${FAKE_CLERK_TOKEN}`)
    .send({ deviceName });
  return res.body.token as string;
}

async function pairDaemon(httpServer: Server, browserToken: string, deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName });
  await request(httpServer)
    .post('/pairing/claim')
    .set('Authorization', `Bearer ${browserToken}`)
    .send({ code: codeRes.body.code });
  const pollRes = await request(httpServer).post('/pairing/poll').send({ deviceCode: codeRes.body.deviceCode });
  return pollRes.body.token as string;
}
```

In the test body, replace line 36:

```ts
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: new FakeIdentityVerifier(
        new Map([[FAKE_CLERK_TOKEN, { clerkUserId: 'clerk-user-1', email: 'test@example.com' }]])
      ),
    });
```

Replace lines 40-41:

```ts
    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');
```

- [ ] **Step 4: Run the daemon test suite**

Run: `npm test -w @companion/daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/device-auth.ts packages/daemon/src/device-auth.test.ts packages/daemon/src/relay-integration.test.ts
git commit -m "feat(daemon): pair via request-code/claim/poll instead of one-shot self-pairing"
```

---

### Task 9: Web app Clerk integration

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/.env.example`
- Modify: `packages/web/src/main.tsx`
- Create: `packages/web/src/BrowserRegistrationGate.tsx`
- Create: `packages/web/src/BrowserRegistrationGate.test.tsx`
- Modify: `packages/web/src/api/devices.ts`
- Modify: `packages/web/src/api/devices.test.ts`
- Delete: `packages/web/src/PairingScreen.tsx`
- Delete: `packages/web/src/PairingScreen.test.tsx`
- Delete: `packages/web/src/api/pairing.ts`
- Delete: `packages/web/src/api/pairing.test.ts`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/App.test.tsx`
- Modify: `packages/web/src/SettingsScreen.tsx`

**Interfaces:**
- Consumes: `POST /devices/register-browser` (Task 6).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Add the Clerk React SDK**

In `packages/web/package.json`, add to `dependencies`:

```json
    "@clerk/clerk-react": "^5.60.0",
```

Run from the repo root: `npm install`

- [ ] **Step 2: Add the env var template**

Create `packages/web/.env.example`:

```
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_RELAY_HTTP_URL=http://localhost:8787
```

- [ ] **Step 3: Wrap the app in `ClerkProvider`**

Replace the full contents of `packages/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set — see packages/web/.env.example');
}

createRoot(rootElement).render(
  <StrictMode>
    <ClerkProvider publishableKey={publishableKey}>
      <App />
    </ClerkProvider>
  </StrictMode>
);
```

- [ ] **Step 4: Add `registerBrowserDevice` to the devices API**

In `packages/web/src/api/devices.ts`, add at the end of the file:

```ts

export interface RegisterBrowserResult {
  token: string;
  deviceId: string;
}

export async function registerBrowserDevice(clerkToken: string): Promise<RegisterBrowserResult> {
  const res = await fetch(`${RELAY_HTTP_URL}/devices/register-browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${clerkToken}` },
    body: JSON.stringify({ deviceName: guessDeviceName() }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to register this browser: HTTP ${res.status}`);
  }
  return (await res.json()) as RegisterBrowserResult;
}

function guessDeviceName(): string {
  return typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.slice(0, 60) : 'Browser';
}
```

In `packages/web/src/api/devices.test.ts`, add:

```ts

describe('registerBrowserDevice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the Clerk token as a bearer header and returns the companion credentials', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer clerk-tok-1');
      return { ok: true, status: 201, json: async () => ({ token: 'tok-1', deviceId: 'dev-1' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await registerBrowserDevice('clerk-tok-1');
    expect(result).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });

  it("throws the relay's error message on failure", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) }))
    );
    await expect(registerBrowserDevice('bad-token')).rejects.toThrow('Unauthorized');
  });
});
```

Add `registerBrowserDevice` to the existing `import { ... } from './devices'` line at the top of `devices.test.ts`, and confirm `vi`, `afterEach` are already imported from `vitest` there (they are, per the existing file).

- [ ] **Step 5: Create `BrowserRegistrationGate`**

Create `packages/web/src/BrowserRegistrationGate.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { registerBrowserDevice } from './api/devices';
import { storeCredentials, type DeviceCredentials } from './storage';

export interface BrowserRegistrationGateProps {
  onRegistered: (credentials: DeviceCredentials) => void;
}

/**
 * Runs once per browser: exchanges the signed-in Clerk session for this
 * browser's own long-lived companion device token, so every request after
 * this uses the existing device-token scheme unchanged.
 */
export default function BrowserRegistrationGate({ onRegistered }: BrowserRegistrationGateProps) {
  const { getToken } = useAuth();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clerkToken = await getToken();
        if (!clerkToken) throw new Error('Not signed in');
        const result = await registerBrowserDevice(clerkToken);
        storeCredentials(result);
        if (!cancelled) onRegistered(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, onRegistered]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : (
        <p className="text-sm text-slate-400">Setting up this browser…</p>
      )}
    </div>
  );
}
```

Create `packages/web/src/BrowserRegistrationGate.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import BrowserRegistrationGate from './BrowserRegistrationGate';
import * as devicesApi from './api/devices';
import { getStoredCredentials, clearStoredCredentials } from './storage';

const mockGetToken = vi.fn();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

describe('BrowserRegistrationGate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearStoredCredentials();
  });

  it('registers the browser, stores credentials, and calls onRegistered', async () => {
    mockGetToken.mockResolvedValue('clerk-tok-1');
    vi.spyOn(devicesApi, 'registerBrowserDevice').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    const onRegistered = vi.fn();

    render(<BrowserRegistrationGate onRegistered={onRegistered} />);

    await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledWith({ token: 'tok-1', deviceId: 'dev-1' }));
    expect(getStoredCredentials()).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });

  it('shows an error if registration fails', async () => {
    mockGetToken.mockResolvedValue('clerk-tok-1');
    vi.spyOn(devicesApi, 'registerBrowserDevice').mockRejectedValue(new Error('Unauthorized'));

    render(<BrowserRegistrationGate onRegistered={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
  });
});
```

- [ ] **Step 6: Delete the retired pairing-code UI and API**

Delete `packages/web/src/PairingScreen.tsx`, `packages/web/src/PairingScreen.test.tsx`, `packages/web/src/api/pairing.ts`, `packages/web/src/api/pairing.test.ts`.

- [ ] **Step 7: Rewrite `App.tsx`**

Replace the full contents of `packages/web/src/App.tsx`:

```tsx
import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router';
import { SignedIn, SignedOut, SignIn, useClerk } from '@clerk/clerk-react';
import BrowserRegistrationGate from './BrowserRegistrationGate';
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
  const { signOut } = useClerk();
  const [credentials, setCredentials] = useState(() => getStoredCredentials());

  // Clearing only the companion device token would leave the browser still
  // Clerk-signed-in, which would silently re-register a brand new device
  // the instant this renders again — defeating the point of unpairing. This
  // is what actually reproduces the old "unpair = logout" behavior now that
  // Clerk holds a second, independent layer of credential.
  const handleUnauthorized = () => {
    clearStoredCredentials();
    setCredentials(undefined);
    void signOut();
  };

  if (!credentials) {
    return (
      <>
        <SignedOut>
          <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
            <SignIn />
          </div>
        </SignedOut>
        <SignedIn>
          <BrowserRegistrationGate onRegistered={setCredentials} />
        </SignedIn>
      </>
    );
  }

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

- [ ] **Step 8: Rewrite `App.test.tsx`**

Replace the full contents of `packages/web/src/App.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as sessionsApi from './api/sessions';
import * as devicesApi from './api/devices';
import { clearStoredCredentials, storeCredentials } from './storage';
import * as useRelayConnectionModule from './use-relay-connection';

let mockSignedIn = false;
const mockSignOut = vi.fn();
vi.mock('@clerk/clerk-react', () => ({
  SignedIn: ({ children }: { children: React.ReactNode }) => (mockSignedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: React.ReactNode }) => (mockSignedIn ? null : <>{children}</>),
  SignIn: () => <div>Sign in to Companion</div>,
  useClerk: () => ({ signOut: mockSignOut }),
}));

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearStoredCredentials();
    window.history.pushState({}, '', '/');
    mockSignedIn = false;
    mockSignOut.mockClear();
  });

  it('shows the Clerk sign-in UI when signed out and there are no stored credentials', () => {
    render(<App />);
    expect(screen.getByText('Sign in to Companion')).toBeInTheDocument();
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

  it('registers this browser after Clerk sign-in and shows the session list', async () => {
    mockSignedIn = true;
    vi.spyOn(devicesApi, 'registerBrowserDevice').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(<App />);

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('redirects an unknown path to the session list', async () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });
    window.history.pushState({}, '', '/some/unknown/path');

    render(<App />);

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('shows the settings screen at /settings and signs out of both layers after a confirmed unpair', async () => {
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

    expect(mockSignOut).toHaveBeenCalled();
  });
});
```

- [ ] **Step 9: Fix the outdated unpair copy in `SettingsScreen.tsx`**

In `packages/web/src/SettingsScreen.tsx`, replace the sentence on line 198:

```tsx
              This will sign you out of this device and you'll need to sign in again to use it.
```

- [ ] **Step 10: Run the full web test suite**

Run: `npm test -w @companion/web`
Expected: PASS.

- [ ] **Step 11: Run the type checker and build**

Run: `npm run build -w @companion/web`
Expected: succeeds with no type errors.

- [ ] **Step 12: Commit**

```bash
git add packages/web/package.json packages/web/.env.example packages/web/src/main.tsx packages/web/src/BrowserRegistrationGate.tsx packages/web/src/BrowserRegistrationGate.test.tsx packages/web/src/api/devices.ts packages/web/src/api/devices.test.ts packages/web/src/App.tsx packages/web/src/App.test.tsx packages/web/src/SettingsScreen.tsx package-lock.json
git rm packages/web/src/PairingScreen.tsx packages/web/src/PairingScreen.test.tsx packages/web/src/api/pairing.ts packages/web/src/api/pairing.test.ts
git commit -m "feat(web): sign in with Clerk, register this browser once, retire the pairing-code UI"
```

---

### Final check

- [ ] Run the full monorepo test suite from the repo root: `npm test`
- [ ] Run the full monorepo build from the repo root: `npm run build`
- [ ] Confirm no remaining references to the retired APIs: `grep -rn "getOrCreateDefaultUser\|consumePairingCode\|redeemPairingCode\|RedeemPairingRequest" packages/*/src` should return nothing outside `dist/` output.
