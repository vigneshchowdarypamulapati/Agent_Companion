# @companion/daemon

Owns and drives Claude Code sessions via the Claude Agent SDK, and exposes a
**local-only** HTTP control surface (bound to `127.0.0.1`) for exercising the
session lifecycle without the relay or web app.

## Run

    npm run build
    npm start

Set `COMPANION_DAEMON_PORT` to change the port (default `4310`).

## Endpoints

- `POST /sessions` `{ projectPath, prompt }` — start the one active session
- `POST /sessions/:id/prompt` `{ text }` — inject a follow-up prompt
- `POST /sessions/:id/respond` `{ requestId, approved, reason? }` — answer a
  pending permission request
- `POST /sessions/:id/pause` — interrupt the current turn
- `POST /sessions/:id/resume` — mark the session running again after a pause
- `POST /sessions/:id/stop` — end the session
- `GET /sessions/:id/events` — poll the event log for that session

## Note

This HTTP surface is for local development and testing only. The relay
integration (a later plan) connects to `SessionManager` directly over an
outbound WebSocket — it does not go through this HTTP layer.
