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

- Real PWA icon set (`vite.config.ts`'s `manifest.icons` is currently empty).
- Web Push notifications — the relay doesn't implement delivery yet.
