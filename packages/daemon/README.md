# @companion/daemon

Owns and drives Claude Code sessions via the Claude Agent SDK. Exposes two
independent control channels into the same `SessionManager`:

- A **local-only** HTTP surface (bound to `127.0.0.1`) for exercising the
  session lifecycle without the relay or web app.
- An **outbound relay client**, when `COMPANION_RELAY_URL` is set: a
  persistent WebSocket to the relay that forwards every `SessionEvent` and
  applies every `Command` the relay routes to this daemon.

## Run

    npm run build
    npm start

## Configuration

- `COMPANION_DAEMON_PORT` — local HTTP surface port (default `4310`).
- `COMPANION_RELAY_URL` — relay WebSocket URL, e.g. `ws://localhost:8787`. If
  unset, the daemon runs exactly as before: local HTTP only, no relay
  connection attempted.
- `COMPANION_DEVICE_NAME` — name this daemon registers as (default: the
  machine's hostname).
- `COMPANION_DEVICE_TOKEN_PATH` — where the daemon persists its relay device
  token after first pairing (default: `~/.companion/daemon-device.json`).

## Endpoints (local HTTP surface)

- `POST /sessions` `{ projectPath, prompt }` — start the one active session
- `POST /sessions/:id/prompt` `{ text }` — inject a follow-up prompt
- `POST /sessions/:id/respond` `{ requestId, approved, reason? }` — answer a
  pending permission request
- `POST /sessions/:id/pause` — interrupt the current turn
- `POST /sessions/:id/resume` — mark the session running again after a pause
- `POST /sessions/:id/stop` — end the session
- `GET /sessions/:id/events` — poll the event log for that session

This HTTP surface is for local development and testing only; it is not
authenticated and only binds to loopback. The relay connection is the
production control channel for the web app.

## Relay connection

On first run with `COMPANION_RELAY_URL` set, the daemon pairs itself to a
human's account — it cannot mint its own credentials, because it has no way
to prove whose machine it is:

1. It calls the relay's `POST /pairing/request-code` (unauthenticated — at
   this point the code belongs to nobody) and gets back a 6-digit `code`,
   a private `deviceCode`, and an expiry 5 minutes out.
2. It prints the `code` to the console for the human, who opens the
   Companion web app — already signed in with Clerk — goes to **Settings →
   Pair a daemon**, and enters it. That browser's `POST /pairing/claim`
   links the pending code to the human's account.
3. Meanwhile the daemon polls `POST /pairing/poll` with its private
   `deviceCode` every 2 seconds. Until the claim happens it gets
   `{ status: 'pending' }`; once it does, that poll mints and returns this
   daemon's own device token. A 5xx or network error mid-poll is retried
   like a `pending` result rather than aborting the attempt, still bounded
   by the code's 5-minute expiry.

An account may have only one daemon at a time — pairing a replacement means
unpairing the existing one first (Settings → Unpair). The returned token is
persisted to `COMPANION_DEVICE_TOKEN_PATH` so subsequent restarts reuse it
without re-pairing. The daemon then opens `wss://<relay>/ws?token=<token>`
and reconnects with exponential backoff (500ms, doubling, capped at 10s) on
any disconnect.

A command the relay routes to this daemon that fails (e.g. references an
unknown or already-stopped session) is turned into a `command_failed` `SessionEvent`
and sent back over the same connection, so a connected browser always sees
why nothing happened rather than silence.
