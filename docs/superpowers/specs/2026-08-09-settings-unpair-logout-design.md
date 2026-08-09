# Settings / Unpair / Logout — Design

## Problem

The app currently has no way to leave a paired browser except manually clearing local storage through devtools. There is also no server-side concept of revoking a device's access at all: once a browser or daemon is paired, its token authenticates forever, even if the device it lives on is lost, stolen, or simply no longer trusted. This is the second of three sequenced post-core features for Claude Companion (after the multi-session dashboard, before push notifications — see the feature roadmap).

## Non-goals

- Managing or revoking *other* paired devices (a "manage devices" list). This feature only lets a device unpair itself.
- Any account/profile fields (email, password, display name). The relay has no multi-user auth model — one implicit user, devices pair to it via a pairing code — so there is nothing to show beyond the calling device's own info.
- Notification-preference settings. That belongs to the push-notifications feature, not yet built.
- Per-session unpair (stopping, hiding, or otherwise acting on an individual *running session* rather than a *device*). Raised during brainstorming and deliberately deferred — revisit once this feature ships.

## Architecture

**Unpair = logout, one action.** Since there is no separate login step — the device token *is* the credential — "unpair this device" is the only exit action needed. It:

1. Calls the relay to revoke this device's token server-side (deletes the `Device` record; that token can never authenticate again).
2. Force-closes any live WebSocket connections currently authenticated as that device (covers a second tab open with the same paired browser — without this, that tab would silently keep working after "unpair").
3. Clears local storage and returns the app to the pairing screen.

This scopes to *this device only*: no listing or revoking other paired devices. It reuses the existing `Device` model unchanged — no protocol-package/Zod schema changes are needed, since neither new endpoint takes a request body; the device is identified purely by its `Authorization` bearer token. There is no device-id-in-URL, so there is no cross-device access surface to defend against.

**Forward-compatibility constraint:** everything server-side (the two new HTTP endpoints, the force-disconnect mechanism) is plain HTTP + bearer-token / WebSocket-close, with nothing browser-specific baked in. A future native (e.g. React Native) client reuses this same relay contract unchanged; only the presentation layer (`SettingsScreen.tsx` itself) is web-specific.

## Relay changes

- `Store.deleteDevice(deviceId): Promise<void>` — new method on the `Store` interface, implemented in `InMemoryStore`. Idempotent: a no-op if the device is already gone.
- `ConnectionHub.disconnectDevice(deviceId): void` — new method; force-closes every live connection currently registered under that deviceId. Requires adding `close(): void` to the `Connection` interface (alongside the existing `send()`), wired in `server.ts`'s WebSocket handler to `ws.close(4403, 'Device unpaired')`. Closing a connection still fires the socket's existing `'close'` handler, so `hub.unregister()` runs its normal cleanup afterward (including, for a daemon device, the existing disconnect-grace-period path from the multi-session dashboard work — no special-casing needed).
- `GET /devices/me` — authenticated (existing `authenticate()` helper); returns `{ id, type, name, createdAt }` for the calling device, built directly from the already-authenticated `Device` object. `tokenHash` and `userId` are never included in the response.
- `POST /devices/unpair` — authenticated; calls `hub.disconnectDevice(device.id)` then `store.deleteDevice(device.id)`, returns `200 { ok: true }`. No request body. If the token was already revoked by a race (e.g. two tabs both unpairing), `authenticate()` itself already returns `401` for the second call — the existing auth-failure path handles it with no new logic required.

## Web changes

- `api/devices.ts` (new) — `getDevice(token): Promise<DeviceInfo>`, `unpairDevice(token): Promise<void>`, following the existing fetch-based pattern in `api/sessions.ts` / `api/pairing.ts`.
- `SettingsScreen.tsx` (new) — on mount, fetches and displays this device's name, type, and "paired since" date, formatted as a plain absolute date (e.g. `Aug 9, 2026`) via `toLocaleDateString()` — a permanent record, not a freshness indicator, so it deliberately does not reuse `format-relative-time.ts` (built for "how recently did this session do something," not "when did this happen once"). An "Unpair this device" button sits behind an inline confirm step (no modal library is used elsewhere in the app, so this follows the existing inline-conditional-render pattern already used for dismiss errors in `SessionList.tsx`). On success, calls the same `onUnpaired` callback prop that `App.tsx` already uses for 401 handling (clear stored credentials, reset to the pairing screen). On failure, shows an inline error and leaves credentials untouched so the user can retry — a failed unpair must never silently log the user out.
- `SessionList.tsx` — adds a small settings link/icon in the existing header row, routing to `/settings`.
- `App.tsx` — new `/settings` route; `SettingsScreen` reuses the existing `handleUnauthorized` handler as its `onUnpaired` prop, since both end in the identical state transition (clear credentials, show `PairingScreen`).

## Data Flow

```
User clicks "Unpair this device" → confirms
  → SettingsScreen calls unpairDevice(token)
    → POST /devices/unpair (Authorization: Bearer <token>)
      → relay authenticates → device resolved
      → hub.disconnectDevice(device.id)   // closes any other live tabs on this device
      → store.deleteDevice(device.id)     // token can never authenticate again
      → 200 { ok: true }
  → SettingsScreen calls onUnpaired()
    → clearStoredCredentials() + reset App state
    → PairingScreen shown
```

If the HTTP call fails (network error, non-2xx), `SettingsScreen` shows the error inline and does not call `onUnpaired()` — the device stays paired and the user can retry or navigate back.

## Error Handling

- `GET /devices/me` / `POST /devices/unpair` without a valid token: `401`, identical shape to every other authenticated route.
- Store or pubsub failure during unpair: caught by the existing generic error-handling middleware in `server.ts` (`400` with the error message) — same pattern as every other route; no bespoke handling needed.
- Client-side network failure calling either endpoint: inline error message in `SettingsScreen`, credentials untouched, retry available.

## Security

- No device can act on any device but itself — the endpoint takes no device-id parameter, so there is no IDOR surface to defend.
- `GET /devices/me`'s response never includes `tokenHash` or `userId`.
- Revocation is real and immediate: the token is deleted from the store (not just flagged), and any other live connection using it is force-closed rather than left to linger until its own natural disconnect.

## Testing Strategy

- **Relay:** `hub.test.ts` — `disconnectDevice` closes only the connections for the target deviceId, leaves others untouched, and daemon connections still trigger the existing grace-period cleanup after being force-closed. `server.test.ts` — both endpoints require auth; `GET /devices/me` returns the expected shape with no sensitive fields; `POST /devices/unpair` actually revokes (a follow-up authenticated request with the same token then 401s) and force-closes other live connections for that device. `in-memory-store.test.ts` — `deleteDevice` removes the device and is a no-op if already removed.
- **Web:** `api/devices.test.ts` — both client functions against mocked fetch. `SettingsScreen.test.tsx` — renders fetched device info; confirm-step interaction; success calls `onUnpaired`; failure shows an inline error and does not call `onUnpaired`.

## Global Constraints

- No changes to `packages/protocol` — neither new endpoint has a request body, so no new Zod schemas are needed.
- `Connection` interface gains exactly one new method (`close(): void`); no other public API on `ConnectionHub` changes shape.
- Existing `ConnectionHub` constructor signature (`store, pubsub, graceMs?, now?`) is unchanged.
- Follows the existing Tailwind dark-theme styling and inline-conditional-render UX patterns already established in `PairingScreen.tsx` / `SessionList.tsx` — no new UI dependencies.
