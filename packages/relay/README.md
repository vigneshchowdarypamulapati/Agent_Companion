# @companion/relay

The hosted relay: pairs daemon and browser devices for a user, and routes
`SessionEvent`s from daemon → browsers and `Command`s from browser → daemon
over WebSocket, persisting both durably.

## Run

    npm run build
    npm start

Set `COMPANION_RELAY_PORT` (default `8787`) and `COMPANION_RELAY_HOST`
(default `0.0.0.0` — unlike the daemon, this server is meant to be
publicly reachable) to configure the listener.

## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /sessions/:id` — current session status (for reconnect/catch-up).
- `GET /sessions/:id/events?since=<seq>` — session event history.

## WebSocket

Connect to `/ws?token=<device-token>`. Daemons send `{kind:'event', ...}`
messages; browsers send `{kind:'command', ...}` messages. The server
routes events to every browser connection for the same user, and commands
to the specific daemon connection that owns the target session.

## Current scope (v1)

- Storage (`Store`) and cross-instance routing (`PubSub`) are in-memory —
  state does not persist across restarts and this process cannot yet be
  horizontally scaled. Both are defined as port interfaces
  (`store.ts`, `pubsub.ts`) specifically so real Postgres/Redis-backed
  implementations can be swapped in later without touching `hub.ts`,
  `pairing.ts`, or `server.ts`.
- A single seeded default user; pairing-code requests are unauthenticated
  (bootstraps the first device). Public multi-user signup is future work.
- Routing a `start_session` command through the relay (remotely starting a
  brand-new session) is not implemented — only commands on an
  already-started session (`inject_prompt`, `respond_to_permission`,
  `pause`, `resume`, `stop`).
- Web Push notification delivery is not implemented — events are stored
  and routed to connected clients only.
