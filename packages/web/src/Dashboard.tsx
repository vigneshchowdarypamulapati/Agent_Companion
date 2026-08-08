import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, SessionEvent, SessionStatus } from '@companion/protocol';
import { RELAY_WS_URL } from './config';
import { getActiveSession, getSessionEvents, UnauthorizedError } from './api/sessions';
import { useRelayConnection, type LiveEvent } from './use-relay-connection';
import SessionStatusBar from './SessionStatusBar';
import ActivityFeed from './ActivityFeed';
import ModifiedFilesPanel from './ModifiedFilesPanel';
import PermissionPrompt from './PermissionPrompt';
import PromptInjectionBox from './PromptInjectionBox';
import SessionControls from './SessionControls';

export interface DashboardProps {
  token: string;
  onUnauthorized: () => void;
}

interface CurrentSession {
  id: string;
  projectPath: string;
  status: SessionStatus;
}

/**
 * Mirrors packages/relay/src/hub.ts's STATUS_BY_EVENT_TYPE exactly, including
 * the deliberate omission of command_failed (it must not change what this UI
 * shows as the session's status — see the plan that introduced command_failed
 * specifically so a recoverable failure couldn't do that). Duplicated here
 * rather than shared via @companion/protocol because it's small, stable, and
 * purely presentational on this side.
 */
const STATUS_BY_EVENT_TYPE: Partial<Record<SessionEvent['type'], SessionStatus>> = {
  permission_request: 'waiting_permission',
  permission_resolved: 'running',
  turn_complete: 'running',
  stopped: 'stopped',
  error: 'stopped',
};

export default function Dashboard({ token, onUnauthorized }: DashboardProps) {
  const [session, setSession] = useState<CurrentSession | undefined>();
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const isFirstConnect = useRef(true);
  // Mirror of `session` that is always current the instant it changes, rather
  // than at the next render. handleLiveEvent needs to read the tracked session
  // id from inside a stable ([]-dependency) callback to filter out events that
  // belong to a *different* session (the relay broadcasts every one of a
  // user's events to every one of their browser connections, unscoped — see
  // packages/relay/src/hub.ts's dispatchLocal), and several live events can
  // arrive between two renders. Same ref-instead-of-dependency reasoning as
  // onUnauthorizedRef below and onEventRef in use-relay-connection.ts.
  const sessionRef = useRef<CurrentSession | undefined>(undefined);
  // False while an initial (or reconnect re-discovery) load is in flight: live
  // events that arrive during that window are staged here instead of being
  // appended, so the history fetch resolving can't silently clobber them. A
  // ref, not state — it's a transient staging area that must be readable from
  // inside a stable callback and must not trigger renders of its own.
  const loadedRef = useRef(false);
  const pendingLiveEventsRef = useRef<LiveEvent[]>([]);
  // Invalidates in-flight loads: bumped on unmount/token change and by each
  // new load, so a superseded load never writes stale state.
  const loadGenerationRef = useRef(0);
  // onUnauthorized is deliberately not a dependency of the mount effect below:
  // App.tsx passes a fresh inline closure on every render, and depending on
  // it directly would re-run the initial session/history fetch any time that
  // reference changes for reasons unrelated to `token` (e.g. a parent
  // re-render). Read the latest callback via a ref instead, same pattern as
  // onEventRef in use-relay-connection.ts.
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const setCurrentSession = useCallback((next: CurrentSession | undefined) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const handleLiveEvent = useCallback(
    (message: LiveEvent) => {
      if (!loadedRef.current) {
        pendingLiveEventsRef.current.push(message);
        return;
      }
      // Live traffic is proof the relay connection is healthy, so a stale
      // banner from an earlier failed REST load has no business staying up.
      setLoadError(undefined);
      // session_started is never filtered by session id: establishing a new
      // current session (with a new id) is its entire purpose.
      if (message.event.type === 'session_started') {
        setLastSeq((prev) => Math.max(prev, message.seq));
        setCurrentSession({ id: message.sessionId, projectPath: message.event.projectPath, status: 'running' });
        setEvents([message.event]);
        return;
      }
      const current = sessionRef.current;
      if (current && message.sessionId !== current.id) {
        // Another of this user's daemons; not the session this view tracks.
        return;
      }
      // Deferred minor: with no tracked session yet there is nothing to filter
      // against, so events are accepted. "This session's own event arriving
      // before its session_started" and "a foreign daemon's event" are not
      // reliably distinguishable here without more information from the relay.
      setLastSeq((prev) => Math.max(prev, message.seq));
      setEvents((prev) => [...prev, message.event]);
      if (current) {
        const nextStatus = STATUS_BY_EVENT_TYPE[message.event.type] ?? current.status;
        if (nextStatus !== current.status) {
          setCurrentSession({ ...current, status: nextStatus });
        }
      }
    },
    [setCurrentSession]
  );

  /**
   * Replays everything staged during a load, in seq order, through
   * handleLiveEvent — the same path real-time events take. Routing them rather
   * than splicing them into `events` directly is what keeps the session-id
   * filter, the status derivation, and the session_started handling from being
   * bypassed for exactly the events that arrived during the race window.
   *
   * `minSeq` is the history snapshot's last seq: anything at or below it is
   * already in the snapshot we just rendered, anything above it arrived after
   * the snapshot was taken and is genuinely new.
   */
  const drainBufferedLiveEvents = useCallback(
    (minSeq: number) => {
      const buffered = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      if (buffered.length === 0) return;
      const late = buffered.filter((message) => message.seq > minSeq).sort((a, b) => a.seq - b.seq);
      for (const message of late) {
        handleLiveEvent(message);
      }
    },
    [handleLiveEvent]
  );

  /**
   * Full session discovery: find the active session, load its history, then
   * replay anything that arrived live while those two REST calls were in
   * flight. Used both on mount and on reconnect when this view isn't tracking
   * a session yet (the session may have started while the socket was down —
   * the session_started event that would have told us was missed).
   */
  const loadSession = useCallback(async () => {
    const generation = (loadGenerationRef.current += 1);
    loadedRef.current = false;
    let historySeq = 0;
    try {
      const active = await getActiveSession(token);
      if (generation !== loadGenerationRef.current) return;
      if (active) {
        // Set before the drain below: the buffered events are replayed through
        // handleLiveEvent, whose session-id filter needs the session it is
        // filtering against to already be in place.
        setCurrentSession({ id: active.id, projectPath: active.projectPath, status: active.status });
        const history = await getSessionEvents(token, active.id);
        if (generation !== loadGenerationRef.current) return;
        historySeq = history.length > 0 ? history[history.length - 1].seq : 0;
        setEvents(history.map((h) => h.event));
        setLastSeq(historySeq);
      }
      setLoadError(undefined);
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      if (err instanceof UnauthorizedError) {
        onUnauthorizedRef.current();
        return;
      }
      // Anything else (relay unreachable, 500, DNS failure) must be visible:
      // silently falling through here is indistinguishable from a healthy
      // relay with nothing running.
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === loadGenerationRef.current) {
        loadedRef.current = true;
        setLoaded(true);
        // Drains on every path, including the no-active-session and failed
        // paths (where historySeq stays 0): a session_started that arrived in
        // the gap between the REST query and now must still be able to
        // establish the session.
        drainBufferedLiveEvents(historySeq);
      }
    }
  }, [token, setCurrentSession, drainBufferedLiveEvents]);

  useEffect(() => {
    void loadSession();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [loadSession]);

  const { connected, sendCommand } = useRelayConnection({
    url: RELAY_WS_URL,
    token,
    onEvent: handleLiveEvent,
    onLog: (message) => console.log('[relay]', message),
  });

  useEffect(() => {
    if (!connected) return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    // Deliberately reacting only to `connected` flipping true again after
    // having connected once before — session/lastSeq/token are read fresh
    // via closure, not tracked as deps, so this doesn't re-run on every event.
    if (!session) {
      // Nothing to fill a gap in: a session may have started (and its
      // session_started event been missed) while the socket was down, so
      // re-run full discovery rather than assuming nothing changed.
      void loadSession();
      return;
    }
    void (async () => {
      try {
        const gap = await getSessionEvents(token, session.id, lastSeq);
        if (gap.length === 0) return;
        setEvents((prev) => [...prev, ...gap.map((g) => g.event)]);
        setLastSeq(gap[gap.length - 1].seq);
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorizedRef.current();
      }
    })();
  }, [connected]);

  function handleSend(command: Command) {
    if (!session) return;
    sendCommand(session.id, command);
  }

  if (!loaded) {
    return <p className="text-slate-400 p-4">Loading…</p>;
  }

  const permissionRequest = findPendingPermissionRequest(events);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-4 max-w-lg mx-auto">
      {loadError && (
        <p role="alert" className="bg-red-900 text-red-100 rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      {(!loadError || session) && (
        <SessionStatusBar
          status={session?.status ?? 'none'}
          projectPath={session?.projectPath}
          connected={connected}
        />
      )}

      {session && permissionRequest && (
        <PermissionPrompt
          sessionId={session.id}
          requestId={permissionRequest.requestId}
          toolName={permissionRequest.toolName}
          input={permissionRequest.input}
          onSend={handleSend}
        />
      )}

      {session && (
        <>
          <SessionControls sessionId={session.id} status={session.status} onSend={handleSend} />
          <PromptInjectionBox
            sessionId={session.id}
            disabled={session.status === 'waiting_permission'}
            onSend={handleSend}
          />
        </>
      )}

      <div>
        <h2 className="text-sm font-semibold text-slate-400 mb-2">Modified files</h2>
        <ModifiedFilesPanel events={events} />
      </div>

      <div>
        <h2 className="text-sm font-semibold text-slate-400 mb-2">Activity</h2>
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}

/** The pending request is a permission_request with no later permission_resolved for the same requestId. */
function findPendingPermissionRequest(
  events: SessionEvent[]
): { requestId: string; toolName: string; input: unknown } | undefined {
  const resolvedRequestIds = new Set<string>();
  for (const event of events) {
    if (event.type === 'permission_resolved') {
      resolvedRequestIds.add(event.requestId);
    }
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'permission_request' && !resolvedRequestIds.has(event.requestId)) {
      return { requestId: event.requestId, toolName: event.toolName, input: event.input };
    }
  }
  return undefined;
}
