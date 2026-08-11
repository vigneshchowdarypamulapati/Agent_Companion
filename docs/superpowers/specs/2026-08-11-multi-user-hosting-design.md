# Multi-User Hosting (Clerk Auth) — Design

## Problem

Today the relay has exactly one seeded user (`getOrCreateDefaultUser()` in
`packages/relay/src/store.ts`). Every paired device — daemon or browser —
attaches to that same user with no real identity check. Concretely,
`packages/daemon/src/device-auth.ts` shows the daemon calls
`POST /pairing/request-code` and then immediately `POST /pairing/redeem`
itself, with zero human step in between — this only works because there is
currently one global account for the whole relay to bootstrap into.

This plan makes the relay genuinely multi-tenant: real accounts, true
public signup (no invite required), so two different people each get a
private view of their own devices and sessions with no cross-visibility.

## Non-Goals

- **No second daemon per account.** One daemon per account, full stop —
  agreed explicitly during design. Monitoring Claude Code sessions from a
  second machine on the same account is a future plan, not this one.
- **No cross-device management UI.** Settings still only lets a device
  unpair *itself* (as shipped). Viewing or unpairing *other* devices on the
  same account from one session is out of scope here.
- **No session history.** Unchanged from the existing product decision —
  only active sessions are shown.
- **No change to `hub.ts`, the WS message protocol, or how daemons report
  sessions.** Connection routing is untouched.
- **No change to the Postgres/Drizzle setup** from the persistent-storage
  plan beyond the schema additions described below.

## Architecture

### Identity provider: Clerk

Chosen over Neon Auth (Neon's own managed-auth add-on) specifically because
Neon Auth's managed Better Auth backend does not currently support
architectures where the frontend and backend are separate deployments — it
relies on HTTP-only cookies, which browsers won't share across the
different origins Companion's web app and relay run on. Clerk is built for
exactly this shape: the frontend obtains a session token and sends it to a
separate backend over `Authorization: Bearer`, verified there with Clerk's
backend SDK — no shared-origin cookie requirement.

### Where Clerk touches the system — deliberately minimal

Clerk is only involved at **one moment**: the first time a *new* browser
proves "this is user X." Every request after that reuses the existing
companion device-token model completely unchanged (`Bearer` header / WS
`?token=`, `hub.ts`, every existing route) — there is no ongoing
per-request Clerk verification anywhere else in the system.

1. The web app integrates Clerk's React SDK (`@clerk/clerk-react`) for
   sign-in/sign-up UI.
2. After a successful Clerk sign-in, if this browser has no stored
   companion device credentials yet, it makes one call to a new relay
   endpoint, `POST /devices/register-browser`, with the Clerk session
   token as `Authorization: Bearer <clerk-token>`.
3. The relay verifies that token server-side via Clerk's backend SDK
   (`@clerk/backend`), resolves or creates the local `users` row keyed by
   the Clerk user id, creates a `browser` device row under that user, and
   mints an opaque companion device token exactly the way every device is
   minted today (`generateToken()` / `hashToken()` in `pairing.ts`).
   Returns `{ token, deviceId }` — the same shape `/pairing/redeem`
   returns today.
4. The web app stores that token in `localStorage` exactly as it does
   today (`storage.ts`, unchanged) and never talks to Clerk again unless it
   logs out or loses that stored token.

An account can have any number of browser devices this way — each does its
own one-time Clerk-authenticated registration, then behaves exactly like a
normal paired device forever after. This is what satisfies "log in from a
different browser and still control your sessions" without adding Clerk
verification to the hot request path.

### Daemon pairing becomes a real two-party handshake

Today's flow — daemon requests a code, then immediately redeems it itself,
with no human step — only works because there's one global account.  With
real per-person accounts, the daemon can no longer decide which account it
belongs to; a human has to confirm that, from their own authenticated
browser. This becomes a standard device-authorization handshake:

1. **`POST /pairing/request-code`** (daemon, unauthenticated) — no longer
   touches `users` at all. Creates a pending pairing-code row: the existing
   short, human-facing `code`, plus a new `deviceCode` (a long opaque
   secret, daemon-only, used for polling — never shown to the human).
   Returns `{ code, deviceCode, expiresAt }`. The daemon persists
   `deviceCode` privately (alongside where it already persists its token
   file) and prints `code` plus a link for the human.
2. **`POST /pairing/claim`** (NEW — browser, authenticated with its own
   already-issued companion device token, like any other request). Body:
   `{ code }`. Looks up the pairing code; must be unexpired and not yet
   claimed. If the caller's account already has a `daemon` device, this
   rejects with `409` ("Account already has a paired daemon — unpair it
   first"), enforcing the one-daemon-per-account rule. Otherwise, it stamps
   the pairing code's `userId` with the caller's account and returns
   `{ ok: true }`. The browser never sees or handles the daemon's token.
3. **`POST /pairing/poll`** (NEW — daemon, using its private `deviceCode`;
   no device token exists yet so this is unauthenticated by design, gated
   only by knowledge of the secret `deviceCode`). Looks up the pairing code
   by `deviceCode`. While `userId` is still unset: `{ status: 'pending' }`,
   and the daemon retries after a short delay. Once claimed: mints the
   actual `daemon` device row and token (same `generateToken()` /
   `hashToken()` as today), marks the pairing code redeemed so it can never
   be claimed or polled again, and returns
   `{ status: 'complete', token, deviceId }`. If the code has expired:
   `{ status: 'expired' }`.

**`POST /pairing/redeem`** (today's generic browser-or-daemon endpoint) is
retired. Browsers now use `/devices/register-browser`; daemons now use the
request-code / claim / poll trio above.

### Schema changes (`packages/relay/src/db/schema.ts`)

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(), // NEW — replaces the hardcoded seeded email as the identity key
  email: text('email').notNull(), // now sourced from Clerk on first sight; uniqueness is Clerk's job, not ours
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const pairingCodes = pgTable('pairing_codes', {
  code: text('code').primaryKey(),
  deviceCode: text('device_code').notNull().unique(), // NEW — daemon's private polling secret
  userId: text('user_id'), // CHANGED — nullable now; null until a browser claims it
  redeemed: boolean('redeemed').notNull().default(false), // NEW — replaces `consumed`; guards single-use redemption, distinct from "claimed"
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});
```

`devices` and `sessions` are unchanged — they already key on an opaque
`userId` text column, which now traces back to a real Clerk-backed account
instead of the one seeded user, with no schema change required on those
two tables.

### `Store` interface changes (`packages/relay/src/store.ts`)

- `getOrCreateDefaultUser(): Promise<User>` → replaced by
  `getOrCreateUserByClerkId(clerkUserId: string, email: string): Promise<User>`.
- `createPairingCode(): Promise<PairingCode>` — no longer takes a `userId`
  parameter; pairing codes start unowned.
- New: `claimPairingCode(code: string, userId: string): Promise<'ok' | 'not_found' | 'expired' | 'already_claimed'>`.
- New: `getPairingCodeByDeviceCode(deviceCode: string): Promise<PairingCode | undefined>`.
- New: `markPairingCodeRedeemed(deviceCode: string): Promise<void>`.
- `consumePairingCode(code: string)` is retired, replaced by the
  claim/poll pair above.
- A way to check for an existing daemon device on an account (e.g.
  `getDaemonDeviceForUser(userId)`), used by `/pairing/claim` to enforce
  one-daemon-per-account — exact shape left to the implementation plan.

### Identity verification boundary

A small injectable interface, following the same pattern `PushSender`
already uses as an optional injected dependency in `main.ts`:

```ts
export interface IdentityVerifier {
  verifyToken(clerkToken: string): Promise<{ clerkUserId: string; email: string } | undefined>;
}
```

The production implementation wraps `@clerk/backend`'s token verification;
tests inject a fake returning a fixed identity. This keeps the one real
Clerk-touching code path testable the same way `postgres-store.test.ts`
tests real Postgres, while everything else in the suite (`hub`, `server`
routes, WS handling) stays exactly as fast and Clerk-free as it is today.

### Web app changes (`packages/web`)

- `PairingScreen.tsx`'s code-entry form and "Get a pairing code" button are
  retired for browsers. A logged-out browser instead sees Clerk's
  sign-in/sign-up UI.
- On a successful Clerk sign-in with no stored companion credentials yet,
  the app makes the one `/devices/register-browser` call described above,
  then proceeds exactly as it does today (`storage.ts`, `SessionsProvider`,
  routing) — unchanged.
- Nothing else in the web app changes: `SessionList`, `SessionDetail`,
  `SettingsScreen`, and push notifications all continue to authenticate
  with the stored companion device token exactly as they do now.

### Daemon changes (`packages/daemon`)

- `device-auth.ts`'s `pairNewDevice` changes from "request a code, then
  immediately redeem it" to "request a code, print it plus a link, then
  poll" — waiting (bounded by the pairing code's existing `expiresAt`) for
  a human to claim it from their browser.

## Testing Strategy

- A fake `IdentityVerifier` for relay tests returns fixed Clerk identities
  — no real Clerk calls anywhere in the automated test suite.
- `store-contract-tests.ts` (shared between `InMemoryStore` and
  `PostgresStore`) gains cases for: `getOrCreateUserByClerkId` upsert
  semantics; pairing-code state transitions (unclaimed → claimed →
  redeemed, expired, already-claimed, double-claim rejected); and the
  one-daemon-per-account rejection.
- `pairing.test.ts` gains the new claim/poll flow; the old single-shot
  `redeemPairingCode` tests are removed since that path is retired.
- `device-auth.test.ts` (daemon) is updated to cover the poll loop instead
  of one-shot redeem.

## Migration/Rollout

No production users exist yet (same starting condition as the
persistent-storage plan), so this is a schema change with no real data to
migrate — the affected columns are dropped/recreated via a fresh Drizzle
migration. Requires provisioning a Clerk application and setting
`CLERK_SECRET_KEY` (relay) and `CLERK_PUBLISHABLE_KEY` (web) as new
required environment variables, following the same fail-fast-if-unset
pattern `DATABASE_URL` already uses in `main.ts`.

## Global Constraints

- Exactly one `daemon` device per account, enforced at `POST
  /pairing/claim`; any number of `browser` devices per account.
- Clerk is verified exactly once per browser device, at registration —
  never on the ongoing request path. All existing routes, the WS handshake,
  and `hub.ts` keep using the companion device-token scheme unchanged.
- Pairing codes are single-use end to end: claimable exactly once,
  pollable/redeemable exactly once after that.
- Device pairings — browser and daemon alike — never expire and are never
  silently revoked; only an explicit unpair (existing `/devices/unpair`,
  unchanged) ends one.
- Adding a second daemon to an existing account, and any UI for managing
  devices other than the one you're currently using, are explicitly out of
  scope for this plan.
