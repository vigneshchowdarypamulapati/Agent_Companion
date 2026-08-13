# @companion/web

Mobile-first PWA for monitoring and controlling an active Claude Code
session started through the Companion daemon, from any browser.

## Run

    npm run dev       # local dev server
    npm run build     # type-check + production build
    npm run preview   # preview the production build

## Configuration

`VITE_CLERK_PUBLISHABLE_KEY` is **required**: `main.tsx` throws at boot if
it's unset, because `ClerkProvider` has nothing to authenticate against
without it. Take it from the Clerk dashboard's API keys page — the same
Clerk application whose secret key the relay is configured with (see
`packages/relay/README.md`); a publishable key from a different application
produces session tokens the relay will reject. Copy the example env file to
fill it in:

    cp packages/web/.env.example packages/web/.env

The relay's URLs are read from `VITE_RELAY_HTTP_URL` / `VITE_RELAY_WS_URL`
at build time (see `src/config.ts`). Unlike the Clerk key, both are optional
and default to `http://localhost:8787` and `ws://localhost:8787` for local
development.

Set `VITE_RELAY_HTTP_URL` alone for a real deployment: `VITE_RELAY_WS_URL` is
derived from it by swapping the scheme (`https://relay.example.com` →
`wss://relay.example.com`), so the two can't drift into a half-configured
state where an HTTPS page is left pointing at a `ws://localhost` socket the
browser blocks as mixed content. Set `VITE_RELAY_WS_URL` explicitly only if
the WebSocket lives at a different host than the REST API.

## Authentication

Two independent credential layers, in this order:

1. **Clerk sign-in.** `main.tsx` wraps the app in `ClerkProvider`; `App.tsx`
   renders Clerk's `<SignIn />` to anyone signed out. This is the identity
   layer — it decides *which account* this person is.
2. **Browser registration.** The first time a signed-in browser has no
   stored companion credentials, `BrowserRegistrationGate` runs once: it
   exchanges the Clerk session token for this browser's own long-lived
   companion device token via `POST /devices/register-browser`, and stores
   it. Every request after that — REST and WebSocket alike — uses that
   device token alone; Clerk is not consulted again. If registration fails,
   the gate shows the error with a Retry button rather than dead-ending.

Because there are two layers, unpairing has to clear both: `handleUnauthorized`
in `App.tsx` drops the stored device token *and* calls Clerk's `signOut()`.
Clearing only the device token would leave the browser Clerk-signed-in, and
the registration gate would silently mint a brand new device on the next
render — defeating the point of unpairing. The same handler runs whenever
the relay answers `401`, so a revoked token always lands back on sign-in.

## Views

Three client-side routes (`react-router`), all behind sign-in and the
browser-registration gate in `App.tsx`:

- `/` — `SessionList`: every one of the user's active sessions (including
  stopped-but-not-yet-dismissed ones), sorted with anything waiting on a
  permission decision first, then by most recent activity.
- `/sessions/:id` — `SessionDetail`: the full live view of one session
  (activity feed, modified files, permission prompt, controls) — this is
  what `Dashboard` used to be before multi-session support.
- `/settings` — `SettingsScreen`: this device's paired info (name, type,
  paired date), a "Pair a daemon" form for entering the 6-digit code a
  daemon prints on first run (`POST /pairing/claim` via `src/api/pairing.ts`
  — this is the only place in the app that links a daemon to the account),
  an "Unpair this device" action behind a confirm step, and (when the
  browser supports Push and the relay has VAPID keys configured) a
  notifications toggle for this device. Unpairing calls the relay to revoke
  the device's token server-side and force-close any other live tab using
  it, then clears local storage *and* signs out of Clerk (see
  Authentication above) before returning to the sign-in screen.

`SessionList` and `SessionDetail` share a single WebSocket connection,
owned by `SessionsProvider` (`src/SessionsProvider.tsx` +
`src/use-sessions-store.ts`) above the router: the relay broadcasts every
event for every one of a user's sessions to every one of their browser
connections unscoped, so both views read off the same stream rather than
opening their own. `SettingsScreen` doesn't need this stream — it talks to
the relay directly over REST (`src/api/devices.ts`, `src/api/pairing.ts`).

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
