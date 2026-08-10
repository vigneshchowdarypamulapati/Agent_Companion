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

Set `COMPANION_RELAY_VAPID_PUBLIC_KEY`, `COMPANION_RELAY_VAPID_PRIVATE_KEY`,
and `COMPANION_RELAY_VAPID_SUBJECT` (a `mailto:` URI, required by the Web
Push protocol) to enable push notifications. All three must be set together
or none take effect — with any missing, the relay runs exactly as it does
today and `GET /push/vapid-public-key` returns `404`.

## REST endpoints

- `POST /pairing/request-code` — issue a 6-digit, 5-minute, single-use
  pairing code for the (single, v1) default user.
- `POST /pairing/redeem` `{ code, deviceType, deviceName }` — exchange a
  pairing code for a long-lived device token.
- `GET /devices/me` — the calling device's own `{ id, type, name, createdAt }`
  (never includes `tokenHash` or `userId`).
- `POST /devices/unpair` — revokes the calling device's token so it can
  never authenticate again, and force-closes every live WebSocket
  connection currently authenticated as that device (including the one
  that made this request, if any). `200 { ok: true }` on success. There is
  no way to unpair a device other than the one making the request — the
  target is always the caller, identified by its own bearer token.
- `GET /push/vapid-public-key` — the relay's public VAPID key, needed by a
  browser to subscribe to push. Unauthenticated (the key isn't secret).
  `404` if the relay has no VAPID keys configured.
- `POST /devices/push-subscription` `{ endpoint, keys: { p256dh, auth } }`
  — stores a Web Push subscription against the calling device.
  `200 { ok: true }` on success, `400` on an invalid subscription body.
- `DELETE /devices/push-subscription` — clears the calling device's
  subscription. `200 { ok: true }` on success (idempotent — succeeds even
  if there was no subscription to clear).
- `GET /sessions/active` — every one of the caller's sessions that isn't
  dismissed: anything not yet stopped, plus anything stopped but not yet
  dismissed. `200` with a (possibly empty) JSON array.
- `POST /sessions/:id/dismiss` — marks a stopped session dismissed, removing
  it from `GET /sessions/active`. `200` on success, `409` if the session
  isn't stopped yet, `404` if unknown or not owned by the caller.
- `GET /sessions/:id` — current session status (for reconnect/catch-up).
- `GET /sessions/:id/events?since=<seq>` — session event history.

`GET /devices/me`, `POST /devices/unpair`, `POST`/`DELETE
/devices/push-subscription`, and all four `/sessions*` routes require
`Authorization: Bearer <device-token>`; unauthenticated requests get `401`.
`GET /push/vapid-public-key` is the one exception — it's intentionally
public. `GET /sessions/active` isn't scoped to a single session id, so it
always succeeds for an authenticated caller:
`200` with a JSON array, empty when the caller has no active sessions.
`GET /sessions/:id`, `GET /sessions/:id/events`, and
`POST /sessions/:id/dismiss` only serve sessions belonging to that device's
user; anything else (missing, or owned by someone else) returns
`404 Unknown session` (never `403`, so session ids cannot be enumerated).
`POST /sessions/:id/dismiss` additionally returns `409` if the session
exists but hasn't stopped yet.

## WebSocket

Connect to `/ws?token=<device-token>` (query-param auth, because browsers
cannot set headers on a WebSocket handshake — REST calls use the
`Authorization` header instead). Daemons send `{kind:'event', ...}`
messages; browsers send `{kind:'command', ...}` messages. The server
routes events to every browser connection for the same user, and commands
to the daemon connections of the device that owns the target session. A
connection is force-closed with code `4403` if its device is unpaired
(`POST /devices/unpair`) while still connected.

Events forwarded to browsers carry the store-assigned `seq`, so a client
can reconcile a `?since=<seq>` history fetch against the live stream
without gaps or duplicates. A message the server refuses to route (bad
JSON, schema violation, or a failed authorization check) is answered with
a `{kind:'error', message}` diagnostic frame — this is not part of the
`RelayMessage` schema and clients may ignore it.

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
- Web Push notifications fire for `permission_request`, `error`, and
  `stopped` events, sent to every one of the recipient's browser devices
  with a stored subscription. Delivery is best-effort: a failed send to
  one device never blocks another device's, or the event's normal routing
  to connected clients.
