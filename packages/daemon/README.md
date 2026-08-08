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

On first run with `COMPANION_RELAY_URL` set, the daemon self-pairs: it calls
the relay's `POST /pairing/request-code` (intentionally unauthenticated in
v1 — see `packages/relay/README.md`) and `POST /pairing/redeem` with
`deviceType: 'daemon'`, then persists the returned token to
`COMPANION_DEVICE_TOKEN_PATH` so subsequent restarts reuse it without
re-pairing. It then opens `wss://<relay>/ws?token=<token>` and reconnects
with exponential backoff (500ms, doubling, capped at 10s) on any disconnect.

A command the relay routes to this daemon that fails (e.g. references an
unknown or already-stopped session) is turned into a `command_failed` `SessionEvent`
and sent back over the same connection, so a connected browser always sees
why nothing happened rather than silence.
