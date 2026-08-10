import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, SessionEvent } from '@companion/protocol';
import { RelayConnection, type RelayConnectionOptions } from './relay-connection';

export interface LiveEvent {
  sessionId: string;
  seq: number;
  event: SessionEvent;
}

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
  createConnection?: (options: RelayConnectionOptions) => Pick<RelayConnection, 'connect' | 'close' | 'sendCommand'>;
}

export interface UseRelayConnectionResult {
  connected: boolean;
  sendCommand: (sessionId: string, command: Command) => void;
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
  const [connected, setConnected] = useState(false);
  const connectionRef = useRef<Pick<RelayConnection, 'connect' | 'close' | 'sendCommand'> | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onLogRef = useRef(onLog);
  onLogRef.current = onLog;
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    const connection = createConnection({
      url,
      token,
      onEvent: (message) => onEventRef.current(message),
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onLog: (message) => onLogRef.current?.(message),
      onUnauthorized: () => onUnauthorizedRef.current?.(),
    });
    connectionRef.current = connection;
    connection.connect();

    return () => {
      connection.close();
      connectionRef.current = undefined;
    };
  }, [url, token]);

  const sendCommand = useCallback((sessionId: string, command: Command) => {
    connectionRef.current?.sendCommand(sessionId, command);
  }, []);

  return { connected, sendCommand };
}
