# Push Notifications — Design

## Problem

Right now the only way to know a Claude Code session needs attention (a permission prompt, an error, or that it stopped) is to have the app open. This is the third and final of three sequenced post-core features for Claude Companion (after the multi-session dashboard and settings/unpair/logout — see the feature roadmap), and closes the gap both prior READMEs already flagged: *"Web Push notification delivery is not implemented — events are stored and routed to connected clients only."*

## Non-goals

- Notifying on any event type beyond `permission_request`, `error`, `stopped`. Easy to extend the trigger set later; not decided against forever, just out of scope now.
- Suppressing a notification when the relevant session is already visible in an open tab. Every qualifying event notifies every paired browser device unconditionally — simpler, and the user explicitly chose this over tracking per-tab visibility state.
- Managing or viewing push subscriptions for devices other than the one you're currently using. Matches the same self-only scoping already established for unpair.
- Any delivery channel other than Web Push (no email, SMS, or native mobile push via a dedicated app).
- Prompting users to "add to home screen" for iOS Safari's Web Push requirement (a platform constraint, not something this app's code controls — see Platform Limitations below).

## Architecture

**Trigger point is a correctness decision, not a style choice.** `ConnectionHub` has two places that see every event: `routeFromDaemon` (runs exactly once per event, on whichever relay instance received that daemon's WebSocket message) and `dispatchLocal` (runs once per relay instance subscribed to the pub/sub channel — this is how live delivery scales horizontally across multiple relay processes). Sending push notifications from `dispatchLocal` would mean every relay instance in a scaled-out deployment independently fires the same push, duplicating notifications. Sending from `routeFromDaemon` fires exactly once per event regardless of how many relay instances exist, so that's where the trigger lives.

**Storage:** a push subscription (the browser's `endpoint` + `keys.p256dh`/`keys.auth`) is 1:1 with a paired browser device, so it's an optional field directly on the existing `Device` record rather than a new store/table. Unpairing a device (already built) automatically clears its subscription for free, with no new cleanup code — deleting the `Device` record deletes the field with it.

**Sending:** a new `PushSender` port (mirroring the existing `Store`/`PubSub` interface pattern), with a real implementation backed by the `web-push` npm package (VAPID-authenticated Web Push — the W3C standard the browser's own Notifications/Push APIs speak, no vendor SDK or third-party notification service). When a qualifying event (`permission_request`, `error`, `stopped`) lands in `routeFromDaemon`, the hub looks up every one of the event's user's *browser* devices with a stored subscription and sends to each independently and in parallel — one device's failure never affects another's, or the response to the daemon.

**Client:** the current `vite-plugin-pwa` `generateSW` mode auto-generates a service worker with no way to add a custom `push` event listener — a hard technical constraint, not a preference. The plan switches to `injectManifest` mode with a small custom service-worker source file that still keeps the existing offline-caching behavior (via Workbox's `precacheAndRoute`) and adds `push`/`notificationclick` listeners alongside it. Clicking a notification focuses or opens the app at that session's `/sessions/:id` route.

**Settings integration:** a new section in the already-built `SettingsScreen`, letting the user enable/disable push for the current browser. Shows one of three states: blocked (browser permission previously denied — unrecoverable from in-app UI, browsers don't allow re-prompting after a denial), off (an Enable button), or on (a Disable button). The section is hidden entirely if the browser doesn't support the Push API, or if the relay has no VAPID keys configured.

## Protocol Changes

One new Zod schema in `packages/protocol`: `PushSubscriptionPayload` — `{ endpoint: string; keys: { p256dh: string; auth: string } }`, the standard Web Push subscription JSON shape. Used both as the client's registration request body and as the record's stored shape (no separate "stored" vs "wire" type).

## Relay Changes

- `Device` gains `pushSubscription?: PushSubscriptionPayload`.
- `Store` gains `setPushSubscription(deviceId: string, subscription: PushSubscriptionPayload | undefined): Promise<void>` (idempotent; `undefined` clears it; no-op if the device doesn't exist) and `getDevicesForUser(userId: string): Promise<Device[]>`.
- New `push-sender.ts`: `PushSender` interface with `send(subscription, payload): Promise<'ok' | 'gone'>`, plus a `PushPayload` type (`{ title: string; body: string; url: string }`).
- New `web-push-sender.ts`: `WebPushSender implements PushSender`, using the `web-push` package. A 404/410 from the push service (subscription expired or the user revoked permission browser-side) returns `'gone'`; any other failure rethrows, letting the caller decide whether to log-and-continue.
- `ConnectionHub`'s constructor gains an optional 5th parameter, `pushSender?: PushSender`, defaulting to `undefined` (push is simply inert if not configured — existing call sites like `new ConnectionHub(store, pubsub)` keep working unchanged). In `routeFromDaemon`, after the existing `appendSessionEvent` + `pubsub.publish` (both unchanged), if `pushSender` is set and the event type is `permission_request`/`error`/`stopped`: fetch `store.getDevicesForUser(connection.userId)`, filter to `type === 'browser' && pushSubscription`, and for each, call `pushSender.send(...)` — each call wrapped in its own try/catch so one device's failure doesn't affect another's or throw out of `routeFromDaemon` itself (mirrors the "must not crash the process" discipline already used in the daemon-disconnect grace-period code). A `'gone'` result clears that device's subscription via `setPushSubscription`.
- Notification payload: `title` is exactly `"Needs your permission"` for `permission_request`, `"Session error"` for `error`, `"Session stopped"` for `stopped`; `body` is the session's `projectPath` (looked up via the existing `store.getSession`); `url` is `/sessions/{sessionId}`.
- Three new routes: `GET /push/vapid-public-key` (unauthenticated — the public key isn't secret; `404` if the relay has no VAPID keys configured, so the client can distinguish "not supported here" from a real error), `POST /devices/push-subscription` (authenticated, body validated against `PushSubscriptionPayload`, stores it against the calling device), `DELETE /devices/push-subscription` (authenticated, clears the calling device's subscription). Both mutating routes act only on the calling device — no device-id parameter, same self-only scoping already established by the unpair endpoints.
- `main.ts` reads three new env vars: `COMPANION_RELAY_VAPID_PUBLIC_KEY`, `COMPANION_RELAY_VAPID_PRIVATE_KEY`, `COMPANION_RELAY_VAPID_SUBJECT`. If any are missing, the relay starts without push configured (no `pushSender` constructed, `vapidPublicKey` left undefined) rather than failing to start — local dev and tests need zero setup to keep working.

## Web Changes

- `api/push.ts`: `getVapidPublicKey(): Promise<string | undefined>` (undefined on 404, following the established fetch-client pattern), `savePushSubscription(token, subscription): Promise<void>`, `deletePushSubscription(token): Promise<void>`.
- `push-notifications.ts`: a thin wrapper around browser APIs — `isPushSupported(): boolean`, `getPermissionState(): NotificationPermission`, `enablePush(token): Promise<void>` (waits for the service worker registration already set up by `vite-plugin-pwa`'s auto-registration, requests `Notification` permission, subscribes via `PushManager` using the fetched VAPID public key, POSTs the resulting subscription to the relay), `disablePush(token): Promise<void>` (reads the existing subscription, unsubscribes browser-side, then DELETEs on the relay), `getExistingSubscriptionState(): Promise<'subscribed' | 'unsubscribed'>`.
- `vite.config.ts` switches `VitePWA`'s strategy from the default (`generateSW`) to `injectManifest`, pointing at a new `src/sw.ts`. That file calls `precacheAndRoute(self.__WB_MANIFEST)` (preserving today's offline-caching behavior) and adds a `push` listener (parses the JSON payload, calls `registration.showNotification` with `tag` set to the notification's `url` so repeat events for the same session replace rather than stack up) and a `notificationclick` listener (focuses an existing app window and navigates it to the notification's URL, or opens a new one).
- `SettingsScreen.tsx` gets a new section below the existing unpair block. On mount, checks `isPushSupported()` and `getVapidPublicKey()`; if either is unavailable, the section renders nothing. Otherwise it checks `getPermissionState()`/`getExistingSubscriptionState()` and renders exactly one of: a "notifications are blocked in your browser settings" message, an "Enable notifications" button, or an "enabled" indicator with a "Disable notifications" button. A failed enable/disable shows an inline error (same `role="alert"` pattern used elsewhere in this component) without changing the displayed state.

## Data Flow

```
Daemon sends a permission_request/error/stopped event
  → relay ConnectionHub.routeFromDaemon()
    → appendSessionEvent() + pubsub.publish()   (existing, unchanged — live WS delivery)
    → NEW: if pushSender configured and event type qualifies:
        → store.getDevicesForUser(userId), filter to browser devices with a subscription
        → for each device, in parallel: pushSender.send(subscription, {title, body, url})
            → 'gone' → store.setPushSubscription(deviceId, undefined)  (self-cleaning)
            → other failure → caught, logged, does not affect other devices or the response
  → routeFromDaemon returns normally regardless of push outcome
```

```
User clicks "Enable notifications" in Settings
  → enablePush(token)
    → navigator.serviceWorker.ready
    → Notification.requestPermission() → must resolve 'granted'
    → getVapidPublicKey() from the relay
    → registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
    → savePushSubscription(token, subscription.toJSON())
  → SettingsScreen re-renders showing the "enabled" state
```

## Error Handling

- Relay: a push-send failure for one device never affects the HTTP/WS response to the daemon or delivery to other devices — caught per-device, logged, discarded.
- Client: a failed `enablePush()`/`disablePush()` at any step (permission denied, subscribe rejected, network error saving to the relay) shows an inline error in `SettingsScreen` and does not change the displayed subscription state.
- `GET /push/vapid-public-key` returning `404` is not an error state client-side — it just means the notifications section doesn't render.

## Security

- The VAPID private key never leaves the relay process; only the public key is ever exposed to clients, via the explicitly public, unauthenticated `GET /push/vapid-public-key`.
- `POST`/`DELETE /devices/push-subscription` both require the same bearer-token auth as every other device-scoped route and act only on the calling device — no device-id parameter, no way to register or clear another device's subscription.
- A push subscription's `endpoint`/`keys` are opaque browser-issued tokens; the payload sent through them (title/body/a session URL) never includes anything more sensitive than a project path already visible in the session list to anyone with that device's token.

## Platform Limitations

- Subscriptions live in the same in-memory `Store` as everything else in this app, so they don't survive a relay restart — this is an existing v1 limitation of the whole app, not something new this feature introduces.
- iOS Safari only supports Web Push for a PWA that's been added to the home screen, not a regular browser tab. This is a platform constraint outside this app's control; no "add to home screen" prompting is built for it (see Non-goals).

## Testing Strategy

- Relay: `web-push-sender.test.ts` — unit tests against a mocked `web-push` module (VAPID setup, 404/410 → `'gone'`, other errors rethrown). `hub.test.ts` — new tests using a recording fake `PushSender` (a local test fixture, matching the existing `fakeConnection` style in that file): confirms `permission_request`/`error`/`stopped` trigger a send to every browser device with a subscription for that user; confirms other event types don't trigger a send; confirms a daemon's own device is never a send target; confirms a `'gone'` result clears that device's subscription; confirms one device's send failure doesn't block another's. `server.test.ts` — new tests for the three routes (auth requirements, `404` when push isn't configured, round-trip subscribe/unsubscribe). `in-memory-store.test.ts` — `setPushSubscription`/`getDevicesForUser`.
- Web: `push-notifications.test.ts` — mocks the `navigator.serviceWorker`/`PushManager`/`Notification` globals (jsdom doesn't implement real Push APIs, so this module's tests inject/mock them directly rather than relying on a real browser). `SettingsScreen.test.tsx` — new tests for the notifications section's three states, mocking `push-notifications.ts` wholesale the same way `api/devices.ts` is already mocked in that file's existing tests.
- `src/sw.ts` itself is not realistically unit-testable in this stack (no real `ServiceWorkerGlobalScope` in Vitest/jsdom) — its handlers are a handful of lines following the standard MDN-documented pattern, and this gap is accepted, consistent with `main.ts` already being untested in this project.

## Global Constraints

- `ConnectionHub`'s constructor signature gains exactly one new optional parameter (`pushSender`), appended after the existing `graceMs`/`now` parameters; all existing call sites keep working unchanged.
- Push notifications are entirely optional infrastructure: with no VAPID env vars configured, the relay starts and runs exactly as it does today, and the web app's Settings screen simply doesn't show the notifications section.
- New dependencies are expected and in-scope for this feature specifically (`web-push` for the relay, `workbox-precaching` for the web package's custom service worker) — this is the one place in the project where adding a dependency is the point, not a shortcut.
- Follows the existing Tailwind dark-theme + inline-conditional-render UX patterns already used throughout `SettingsScreen.tsx` — no new UI dependencies beyond what's needed for the service worker itself.
