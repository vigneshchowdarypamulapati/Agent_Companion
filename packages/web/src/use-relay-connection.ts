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
  const { url, token, onEvent, createConnection = (opts) => new RelayConnection(opts) } = options;
  const [connected, setConnected] = useState(false);
  const connectionRef = useRef<Pick<RelayConnection, 'connect' | 'close' | 'sendCommand'> | undefined>(undefined);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const connection = createConnection({
      url,
      token,
      onEvent: (message) => onEventRef.current(message),
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
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
