import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
import { RELAY_WS_URL } from './config';
import { getActiveSessions, dismissSession as apiDismissSession, UnauthorizedError } from './api/sessions';
import { useRelayConnection, type CommandAckResult, type ConnectionState, type LiveEvent } from './use-relay-connection';

export type { ConnectionState };

export interface SessionSummary {
  id: string;
  projectPath: string;
  status: SessionStatus;
  lastEventAt: number;
}

/**
 * Mirrors packages/relay/src/hub.ts's STATUS_BY_EVENT_TYPE exactly, including
 * the deliberate omission of command_failed (a recoverable command failure
 * must not change what this UI shows as the session's status). This is now
 * the single place this map is duplicated on the web side.
 */
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  assistant_text: 'running',
  tool_use: 'running',
  turn_complete: 'waiting_input',
  stopped: 'stopped',
  error: 'stopped',
  // events_dropped: deliberately absent. It reports a gap in the delivered history (events the
  // daemon's outbound buffer had to evict), not a change in what the session is actually doing —
  // the session's real status is whatever the next real event says it is.
};

export interface UseSessionsStoreResult {
  sessions: SessionSummary[];
  loaded: boolean;
  connectionState: ConnectionState;
  loadError: string | undefined;
  dismissSession: (sessionId: string) => Promise<void>;
  sendCommand: (sessionId: string, command: Command) => Promise<CommandAckResult>;
  /** The device-scoped RPC channel — see use-relay-connection.ts's UseRelayConnectionResult.
   * Not consumed by any UI component yet; this is a seam for Project 3 (session adoption). */
  callDaemon: (method: string, params?: unknown) => Promise<unknown>;
  subscribe: (sessionId: string, handler: (message: LiveEvent) => void) => () => void;
}

export function useSessionsStore(token: string, onUnauthorized: () => void): UseSessionsStoreResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const sessionsRef = useRef<SessionSummary[]>([]);
  const loadedRef = useRef(false);
  const pendingLiveEventsRef = useRef<LiveEvent[]>([]);
  const loadGenerationRef = useRef(0);
  const subscribersRef = useRef<Map<string, Set<(message: LiveEvent) => void>>>(new Map());
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const setSessionsState = useCallback((next: SessionSummary[]) => {
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  const notifySubscribers = useCallback((message: LiveEvent) => {
    const handlers = subscribersRef.current.get(message.sessionId);
    if (!handlers) return;
    for (const handler of handlers) handler(message);
  }, []);

  /**
   * Applies one live event to the session-summary list. Does NOT notify
   * per-session subscribers — that happens exactly once, at arrival time, in
   * handleLiveEvent below. Called a second time for buffered events (via
   * drainBufferedLiveEvents), which must NOT re-notify subscribers or a
   * mounted SessionDetail would receive the same event twice.
   */
  const updateSessionsFromEvent = useCallback(
    (message: LiveEvent) => {
      if (message.event.type === 'session_started') {
        const next = sessionsRef.current.filter((s) => s.id !== message.sessionId);
        next.push({
          id: message.sessionId,
          projectPath: message.event.projectPath,
          status: 'running',
          lastEventAt: message.event.at,
        });
        setSessionsState(next);
        return;
      }
      const existing = sessionsRef.current.find((s) => s.id === message.sessionId);
      // An event for a session this list doesn't know about yet — nothing to
      // update.
      if (!existing) return;
      const nextStatus = STATUS_BY_EVENT_TYPE[message.event.type] ?? existing.status;
      setSessionsState(
        sessionsRef.current.map((s) =>
          s.id === message.sessionId ? { ...s, status: nextStatus, lastEventAt: message.event.at } : s
        )
      );
    },
    [setSessionsState]
  );

  const drainBufferedLiveEvents = useCallback(() => {
    const buffered = pendingLiveEventsRef.current;
    pendingLiveEventsRef.current = [];
    if (buffered.length === 0) return;
    const ordered = [...buffered].sort((a, b) => a.seq - b.seq);
    for (const message of ordered) {
      setLoadError(undefined);
      updateSessionsFromEvent(message);
    }
  }, [updateSessionsFromEvent]);

  const handleLiveEvent = useCallback(
    (message: LiveEvent) => {
      // Fans out to this session's detail view (if one is mounted) exactly
      // once per arrival, regardless of whether the list tier is still
      // loading — the detail view does its own independent buffering.
      notifySubscribers(message);
      if (!loadedRef.current) {
        pendingLiveEventsRef.current.push(message);
        return;
      }
      setLoadError(undefined);
      updateSessionsFromEvent(message);
    },
    [notifySubscribers, updateSessionsFromEvent]
  );

  const loadSessions = useCallback(async () => {
    const generation = (loadGenerationRef.current += 1);
    loadedRef.current = false;
    try {
      const active = await getActiveSessions(token);
      if (generation !== loadGenerationRef.current) return;
      setSessionsState(
        active.map((s) => ({ id: s.id, projectPath: s.projectPath, status: s.status, lastEventAt: s.lastEventAt }))
      );
      setLoadError(undefined);
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorizedRef.current();
        return;
      }
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGenerationRef.current) {
        loadedRef.current = true;
        setLoaded(true);
        drainBufferedLiveEvents();
      }
    }
  }, [token, setSessionsState, drainBufferedLiveEvents]);

  useEffect(() => {
    void loadSessions();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [loadSessions]);

  const { connectionState, sendCommand, callDaemon } = useRelayConnection({
    url: RELAY_WS_URL,
    token,
    onEvent: handleLiveEvent,
    onLog: (message) => console.log('[relay]', message),
    onUnauthorized: () => onUnauthorizedRef.current(),
  });

  const isFirstConnect = useRef(true);
  useEffect(() => {
    if (connectionState !== 'live') return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    // The list is cheap to reload in full, so a reconnect just re-runs
    // discovery rather than diffing what changed while the socket was down
    // — simpler, and correct for sessions that started, stopped, or changed
    // status during the gap.
    void loadSessions();
  }, [connectionState, loadSessions]);

  const dismissSessionFn = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        await apiDismissSession(token, sessionId);
        setSessionsState(sessionsRef.current.filter((s) => s.id !== sessionId));
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorizedRef.current();
          return;
        }
        throw err;
      }
    },
    [token, setSessionsState]
  );

  const subscribe = useCallback((sessionId: string, handler: (message: LiveEvent) => void): (() => void) => {
    let handlers = subscribersRef.current.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      subscribersRef.current.set(sessionId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
      if (handlers && handlers.size === 0) {
        subscribersRef.current.delete(sessionId);
      }
    };
  }, []);

  return { sessions, loaded, connectionState, loadError, dismissSession: dismissSessionFn, sendCommand, callDaemon, subscribe };
}
