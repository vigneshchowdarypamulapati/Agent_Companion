import { useCallback, useEffect, useRef, useState } from 'react';
import { RPC_ERROR_CODES } from '@companion/protocol';
import type { Command, SessionEvent } from '@companion/protocol';
import {
  RelayConnection,
  RpcError,
  RPC_ERROR_MESSAGES,
  type CommandAckResult,
  type RelayConnectionOptions,
} from './relay-connection';

export interface LiveEvent {
  sessionId: string;
  seq: number;
  event: SessionEvent;
}

export type { CommandAckResult };

/**
 * The one source of truth for "is this actually live right now" — every badge in the UI reads
 * this instead of keeping its own boolean, so there is exactly one place that can be wrong.
 *
 *   - 'connecting':   the very first connection attempt hasn't succeeded yet.
 *   - 'live':         the socket is open and the device reports it has network connectivity.
 *   - 'reconnecting': it connected successfully at least once, and is currently down and retrying.
 *   - 'offline':      `navigator.onLine` says the device itself has no network — this overrides
 *                      the socket's own state, because a relay-unreachable error in that case is
 *                      the phone's radio, not the relay, and the UI must not blame the server for it.
 */
export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface UseRelayConnectionOptions {
  url: string;
  token: string;
  onEvent: (message: LiveEvent) => void;
  /**
   * Diagnostic sink for the connection's own lifecycle messages (connect,
   * error, unparseable frame, dropped command). Without it a deployed build
   * has no signal at all when the socket can't come up — e.g. a mixed-content
   * ws:// URL on an https:// page. Read via a ref, like onEvent, so a caller
   * passing a fresh inline closure each render doesn't force a reconnect.
   */
  onLog?: (message: string) => void;
  /**
   * Fired when the underlying connection reports its token was rejected (relay close code
   * 4401/4403). Read via a ref, like onEvent/onLog, for the same reason.
   */
  onUnauthorized?: () => void;
  /**
   * Overridable purely for testing — production code never passes this and
   * always gets a real RelayConnection. Intentionally excluded from the
   * mount effect's dependency array below: it's a fixed injection seam, not
   * a value that should trigger a reconnect if a caller's reference changes.
   */
  createConnection?: (
    options: RelayConnectionOptions
  ) => Pick<RelayConnection, 'connect' | 'close' | 'sendCommand' | 'checkLiveness' | 'callDaemon'>;
}

export interface UseRelayConnectionResult {
  connectionState: ConnectionState;
  /**
   * Resolves once the command's outcome is known — a real ack, a client-side timeout, or the
   * connection being torn down while the command was still pending (see RelayConnection's
   * `sendCommand` doc comment for the full lifecycle). Never rejects: 'failed' is a resolved
   * value, not a thrown error, so callers (e.g. PromptInjectionBox) can await it without a
   * try/catch. The promise always settles — `sendCommand`'s underlying RelayConnection
   * guarantees exactly one onCommandAck call per commandId no matter how it resolves.
   */
  sendCommand: (sessionId: string, command: Command) => Promise<CommandAckResult>;
  /**
   * Sibling of `sendCommand`, but for the device-scoped RPC channel (see relay-connection.ts's
   * `callDaemon` doc comment) — a question that isn't about any existing session, e.g. "what
   * sessions could I adopt?" (Project 3). Resolves with the daemon's result or rejects with a
   * typed RpcError; unlike `sendCommand` this can genuinely reject, since there's no equivalent
   * of a resolved-but-failed CommandAckResult for a request that never went anywhere.
   */
  callDaemon: (method: string, params?: unknown) => Promise<unknown>;
}

export function useRelayConnection(options: UseRelayConnectionOptions): UseRelayConnectionResult {
  const {
    url,
    token,
    onEvent,
    onLog,
    onUnauthorized,
    createConnection = (opts) => new RelayConnection(opts),
  } = options;
  const [socketOpen, setSocketOpen] = useState(false);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  // Mutated synchronously in the 'open' handler below, right before the setSocketOpen call that
  // triggers the re-render reading it — a ref rather than state because it only ever needs to
  // flip once (true stays true for the life of this hook instance) and doesn't need its own
  // render pass.
  const hasConnectedOnceRef = useRef(false);
  const connectionRef = useRef<
    Pick<RelayConnection, 'connect' | 'close' | 'sendCommand' | 'checkLiveness' | 'callDaemon'> | undefined
  >(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  /** Resolvers for sendCommand's promise, keyed by commandId — settled from the
   * onCommandAck callback wired into the connection below. */
  const pendingAcksRef = useRef<Map<string, (result: CommandAckResult) => void>>(new Map());

  useEffect(() => {
    const connection = createConnection({
      url,
      token,
      onEvent: (message) => onEventRef.current(message),
      onOpen: () => {
        hasConnectedOnceRef.current = true;
        setSocketOpen(true);
      },
      onClose: () => setSocketOpen(false),
      onLog: (message) => onLogRef.current?.(message),
      onUnauthorized: () => onUnauthorizedRef.current?.(),
      onCommandAck: (commandId, result) => {
        const resolve = pendingAcksRef.current.get(commandId);
        if (!resolve) return;
        pendingAcksRef.current.delete(commandId);
        resolve(result);
      },
    });
    connectionRef.current = connection;
    connection.connect();

    return () => {
      connection.close();
      connectionRef.current = undefined;
    };
  }, [url, token]);

  // Liveness is only ever re-verified in response to one of these two signals, never on a
  // timer — see RelayConnection.checkLiveness's doc comment for why polling isn't needed and
  // would just disturb a healthy-but-idle connection. visibilitychange is the one that matters
  // for phones: Android and iOS alike commonly keep a socket reading OPEN after the device
  // slept through the underlying connection dying, and visibilitychange→visible fires the
  // instant the user looks at the screen again. It also fires on a plain tab switch (Android
  // Chrome does this even for switching apps briefly) — harmless here, since checkLiveness only
  // acts when the connection actually looks stale.
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      connectionRef.current?.checkLiveness();
    }
    function handleOnline() {
      setIsOnline(true);
      connectionRef.current?.checkLiveness();
    }
    function handleOffline() {
      setIsOnline(false);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const connectionState: ConnectionState = !isOnline
    ? 'offline'
    : socketOpen
      ? 'live'
      : hasConnectedOnceRef.current
        ? 'reconnecting'
        : 'connecting';

  const sendCommand = useCallback((sessionId: string, command: Command): Promise<CommandAckResult> => {
    return new Promise((resolve) => {
      const connection = connectionRef.current;
      if (!connection) {
        // No connection object exists at all (called before mount or after unmount) — nothing
        // will ever call back, so resolve failed immediately rather than hanging forever.
        resolve({ status: 'failed', message: 'Not connected to the relay' });
        return;
      }
      const commandId = connection.sendCommand(sessionId, command);
      pendingAcksRef.current.set(commandId, resolve);
    });
  }, []);

  const callDaemon = useCallback((method: string, params?: unknown): Promise<unknown> => {
    const connection = connectionRef.current;
    if (!connection) {
      // No connection object exists at all (called before mount or after unmount) — nothing will
      // ever settle this, so reject immediately rather than hanging forever. Mirrors sendCommand's
      // identical "no connection" case above, but rejects (not resolves) since RpcError is how
      // every callDaemon failure is reported — see that class's doc comment.
      return Promise.reject(
        new RpcError(RPC_ERROR_CODES.NOT_CONNECTED, RPC_ERROR_MESSAGES[RPC_ERROR_CODES.NOT_CONNECTED])
      );
    }
    return connection.callDaemon(method, params);
  }, []);

  return { connectionState, sendCommand, callDaemon };
}
