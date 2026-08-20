/**
 * The stable set of RPC failure reasons every layer of the device-scoped RPC channel (relay hub,
 * daemon method registry, web client) can produce or switch on. `RpcResponseMessage.error` (see
 * relay.ts) is deliberately just a `z.string()` on the wire — the envelope layer doesn't know or
 * care about method-registry concerns — but every *producer* of that field in this codebase is
 * expected to only ever write one of the values below, and every *consumer* that wants to render
 * something more useful than "something went wrong" switches on this fixed set rather than
 * pattern-matching prose. Centralizing the set here (rather than each producer inventing its own
 * strings) is what makes that contract actually hold across three separate packages.
 *
 * A code intentionally carries no human-readable detail — see web's relay-connection.ts for where
 * that's added back for display, kept separate so the wire payload never leaks implementation
 * detail (a stack trace, a store error message) to another device.
 */
export const RPC_ERROR_CODES = {
  /** The requesting user has no daemon device paired to their account at all. */
  NO_DAEMON: 'no_daemon',
  /** The user has a paired daemon, but it has no live connection to this relay right now. */
  DAEMON_DISCONNECTED: 'daemon_disconnected',
  /** No response arrived within the caller's timeout. Produced client-side (see web's
   * relay-connection.ts) — the relay's own bookkeeping is a longer-lived memory-safety backstop,
   * not what actually times out a caller; see PENDING_RPC_REQUEST_TTL_MS in hub.ts for why. */
  TIMEOUT: 'timeout',
  /** The daemon's method registry has no handler for the requested method — e.g. an old cached
   * service worker calling a method a newer daemon renamed or removed. */
  UNKNOWN_METHOD: 'unknown_method',
  /** The requesting device already has too many RPCs awaiting a response; the relay refuses to
   * accept another rather than let a client that never reads its responses grow this without
   * bound. See RPC_IN_FLIGHT_CAP_PER_DEVICE in hub.ts. */
  IN_FLIGHT_CAP_EXCEEDED: 'in_flight_cap_exceeded',
  /** The daemon's handler for a known method threw. */
  HANDLER_ERROR: 'handler_error',
  /** The `start_session` caller gave a `projectPath` that is not in the daemon's known project
   * history, not under its configured `COMPANION_PROJECTS_ROOT` (if one is set), or no longer
   * exists on disk. One code covers all three causes: the remedy is identical from the caller's
   * side (re-list, pick again), and splitting them risks leaking filesystem structure for no
   * actionable benefit. */
  INVALID_PROJECT_PATH: 'invalid_project_path',
  /** The daemon already has `maxConcurrentSessions` non-stopped sessions running; `start_session`
   * refuses to start another until one stops. See `SessionManager`'s concurrency cap. */
  CONCURRENT_SESSION_LIMIT: 'concurrent_session_limit',
  /** The `adopt_session` caller gave a `sessionId` that is no longer discoverable under the
   * given `projectPath` — never existed there, or existed but the underlying transcript file
   * has since been deleted or moved between the list call and the adopt call. One code covers
   * both causes, same reasoning as INVALID_PROJECT_PATH: the remedy is identical (re-list, pick
   * again). */
  SESSION_NOT_FOUND: 'session_not_found',
  /** Produced entirely client-side, never sent over the wire: the browser has no open socket to
   * the relay at all right now, so there is nothing to route the request through. Distinct from
   * `daemon_disconnected` (relay reachable, daemon isn't) — this is "we can't even ask." */
  NOT_CONNECTED: 'not_connected',
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];
