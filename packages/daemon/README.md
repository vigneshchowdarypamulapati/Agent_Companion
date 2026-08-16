# @companion/daemon

Owns and drives Claude Code sessions via the Claude Agent SDK. Exposes two
independent control channels into the same `SessionManager`:

- A **local-only** HTTP surface (bound to `127.0.0.1`, opt-in, authenticated
  — see below) for exercising the session lifecycle without the relay or web
  app.
- An **outbound relay client**, when `COMPANION_RELAY_URL` is set: a
  persistent WebSocket to the relay that forwards every `SessionEvent` and
  applies every `Command` the relay routes to this daemon.

## Run

    npm run build
    npm start

Requires at least one of the two control channels below
(`COMPANION_RELAY_URL` or `COMPANION_DAEMON_HTTP=1`) to be configured. With
neither set, the daemon refuses to start — it exits non-zero with an
actionable error rather than starting and immediately exiting 0 (which a
process supervisor would read as an intentional clean shutdown) or idling
forever with no way to ever be controlled.

## Configuration

- `COMPANION_DAEMON_HTTP` — set to `1` or `true` to turn on the local HTTP
  control surface. **Off by default**, including in production. See
  "Local HTTP surface" below for why.
- `COMPANION_DAEMON_PORT` — local HTTP surface port (default `4310`).
- `COMPANION_LOCAL_HTTP_TOKEN_PATH` — where the daemon persists the bearer
  token that authenticates local HTTP requests (default:
  `~/.companion/daemon-local-http.json`).
- `COMPANION_RELAY_URL` — relay WebSocket URL, e.g. `ws://localhost:8787`. If
  unset, the daemon runs exactly as before: no relay connection attempted.
  This is independent of `COMPANION_DAEMON_HTTP` — the relay connection
  works the same whether or not the local HTTP surface is enabled.
- `COMPANION_DEVICE_NAME` — name this daemon registers as (default: the
  machine's hostname).
- `COMPANION_DEVICE_TOKEN_PATH` — where the daemon persists its relay device
  token after first pairing (default: `~/.companion/daemon-device.json`).

## Local HTTP surface

This surface owns Claude Code sessions with full tool access (file writes,
shell commands). Historically it started unconditionally and had no
authentication — any web page the user's browser visited could DNS-rebind a
hostname it controls to `127.0.0.1` and `POST /sessions` to start a session
on the victim's machine. It is now for local development and testing only,
and three independent layers enforce that:

1. **Opt-in.** It does not start unless `COMPANION_DAEMON_HTTP` is `1` or
   `true`. Unset — the normal production configuration — means the port is
   never bound at all; the relay connection remains the production control
   channel and is unaffected.
2. **Bearer token.** Every route requires `Authorization: Bearer <token>`.
   The token is 32 random bytes (hex-encoded) generated on first run and
   persisted to `COMPANION_LOCAL_HTTP_TOKEN_PATH` (mode `0600` on POSIX,
   same approach as the relay device token). It is also printed to the
   daemon's stdout at startup.
3. **Host allowlist.** Any request whose `Host` header isn't
   `127.0.0.1:<port>`, `[::1]:<port>`, or `localhost:<port>` gets `403`. This
   is the layer that actually defeats DNS rebinding: a page rebound to
   loopback still sends its real hostname in the `Host` header, which is
   never one of the three above.

A missing or wrong bearer token is `401`; a bad `Host` header is `403`. Both
checks run before body parsing and before any route handler, so a rejected
request never reaches `SessionManager`.

### Endpoints

- `POST /sessions` `{ projectPath, prompt }` — start the one active session
- `POST /sessions/:id/prompt` `{ text }` — inject a follow-up prompt
- `POST /sessions/:id/respond` `{ requestId, approved, reason? }` — answer a
  pending permission request
- `POST /sessions/:id/pause` — interrupt the current turn
- `POST /sessions/:id/resume` — mark the session running again after a pause
- `POST /sessions/:id/stop` — end the session
- `GET /sessions/:id/events` — poll the event log for that session

## Relay connection

On first run with `COMPANION_RELAY_URL` set, the daemon pairs itself to a
human's account — it cannot mint its own credentials, because it has no way
to prove whose machine it is:

1. It calls the relay's `POST /pairing/request-code` (unauthenticated — at
   this point the code belongs to nobody) and gets back an 8-character `code`
   (Crockford base32, excluding the visually-ambiguous `I`/`L`/`O` and the
   profanity-prone `U` — 40 bits), a private `deviceCode`, and an expiry 5
   minutes out.
2. It prints the `code` to the console, grouped as `XXXX-XXXX` for
   typeability, for the human, who opens the Companion web app — already
   signed in with Clerk — goes to **Settings → Pair a daemon**, and enters
   it. Case doesn't matter and the hyphen is optional — that browser's
   `POST /pairing/claim` normalizes before matching. It links the pending
   code to the human's account.
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
