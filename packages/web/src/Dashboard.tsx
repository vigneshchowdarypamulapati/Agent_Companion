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
  const isFirstConnect = useRef(true);
  // onUnauthorized is deliberately not a dependency of the mount effect below:
  // App.tsx passes a fresh inline closure on every render, and depending on
  // it directly would re-run the initial session/history fetch any time that
  // reference changes for reasons unrelated to `token` (e.g. a parent
  // re-render). Read the latest callback via a ref instead, same pattern as
  // onEventRef in use-relay-connection.ts.
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const active = await getActiveSession(token);
        if (cancelled) return;
        if (active) {
          setSession({ id: active.id, projectPath: active.projectPath, status: active.status });
          const history = await getSessionEvents(token, active.id);
          if (cancelled) return;
          setEvents(history.map((h) => h.event));
          if (history.length > 0) setLastSeq(history[history.length - 1].seq);
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorizedRef.current();
          return;
        }
        throw err;
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleLiveEvent = useCallback((message: LiveEvent) => {
    setLastSeq((prev) => Math.max(prev, message.seq));
    if (message.event.type === 'session_started') {
      setSession({ id: message.sessionId, projectPath: message.event.projectPath, status: 'running' });
      setEvents([message.event]);
      return;
    }
    setEvents((prev) => [...prev, message.event]);
    setSession((prev) =>
      prev ? { ...prev, status: STATUS_BY_EVENT_TYPE[message.event.type] ?? prev.status } : prev
    );
  }, []);

  const { connected, sendCommand } = useRelayConnection({
    url: RELAY_WS_URL,
    token,
    onEvent: handleLiveEvent,
  });

  useEffect(() => {
    if (!connected) return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    if (!session) return;
    // Deliberately reacting only to `connected` flipping true again after
    // having connected once before — session/lastSeq/token are read fresh
    // via closure, not tracked as deps, so this doesn't re-run on every event.
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
      <SessionStatusBar status={session?.status ?? 'none'} projectPath={session?.projectPath} connected={connected} />

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
