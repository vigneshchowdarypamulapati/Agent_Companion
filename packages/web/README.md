# @companion/web

Mobile-first PWA for monitoring and controlling an active Claude Code
session started through the Companion daemon, from any browser.

## Run

    npm run dev       # local dev server
    npm run build     # type-check + production build
    npm run preview   # preview the production build

## Configuration

The relay's URLs are read from `VITE_RELAY_HTTP_URL` / `VITE_RELAY_WS_URL`
at build time (see `src/config.ts`). Both are optional and default to
`http://localhost:8787` and `ws://localhost:8787` for local development.

Set `VITE_RELAY_HTTP_URL` alone for a real deployment: `VITE_RELAY_WS_URL` is
derived from it by swapping the scheme (`https://relay.example.com` →
`wss://relay.example.com`), so the two can't drift into a half-configured
state where an HTTPS page is left pointing at a `ws://localhost` socket the
browser blocks as mixed content. Set `VITE_RELAY_WS_URL` explicitly only if
the WebSocket lives at a different host than the REST API.

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
  paired date), an "Unpair this device" action behind a confirm step, and
  (when the browser supports Push and the relay has VAPID keys configured)
  a notifications toggle for this device. Unpairing calls the relay to
  revoke the device's token server-side and force-close any other live tab
  using it, then clears local storage and returns to the pairing screen —
  there is no separate "logout" distinct from unpairing, since the device
  token is the only credential this app has.

`SessionList` and `SessionDetail` share a single WebSocket connection,
owned by `SessionsProvider` (`src/SessionsProvider.tsx` +
`src/use-sessions-store.ts`) above the router: the relay broadcasts every
event for every one of a user's sessions to every one of their browser
connections unscoped, so both views read off the same stream rather than
opening their own. `SettingsScreen` doesn't need this stream — it talks to
the relay directly over REST (`src/api/devices.ts`).

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

## Follow-up (not in this plan)

- Real PWA icon set (`vite.config.ts`'s `manifest.icons` is currently empty).
