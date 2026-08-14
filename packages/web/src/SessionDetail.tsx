import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router';
import type { Command, SessionEvent } from '@companion/protocol';
import { getSessionEvents, UnauthorizedError } from './api/sessions';
import { useSessions } from './SessionsProvider';
import type { LiveEvent } from './use-relay-connection';
import SessionStatusBar from './SessionStatusBar';
import ActivityFeed from './ActivityFeed';
import ModifiedFilesPanel from './ModifiedFilesPanel';
import PermissionPrompt from './PermissionPrompt';
import PromptInjectionBox from './PromptInjectionBox';
import SessionControls from './SessionControls';

export interface SessionDetailProps {
  token: string;
  onUnauthorized: () => void;
}

export default function SessionDetail({ token, onUnauthorized }: SessionDetailProps) {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? '';
  const { sessions, loaded: sessionsLoaded, connected, sendCommand, subscribe } = useSessions();

  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const historyLoadedRef = useRef(false);
  const pendingLiveEventsRef = useRef<LiveEvent[]>([]);
  const loadGenerationRef = useRef(0);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  /**
   * No sessionId filtering needed here, unlike the pre-multi-session
   * Dashboard: `subscribe` (below) only ever calls this handler for events
   * belonging to `sessionId` — that filtering already happened once,
   * centrally, in use-sessions-store.ts.
   */
  const handleLiveEvent = useCallback((message: LiveEvent) => {
    if (!historyLoadedRef.current) {
      pendingLiveEventsRef.current.push(message);
      return;
    }
    setLoadError(undefined);
    if (message.event.type === 'session_started') {
      setLastSeq(message.seq);
      setEvents([message.event]);
      return;
    }
    setLastSeq((prev) => Math.max(prev, message.seq));
    setEvents((prev) => [...prev, message.event]);
  }, []);

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

  // Registered before the history fetch below is kicked off, so a live event
  // that arrives while that fetch is in flight is never missed.
  useEffect(() => {
    return subscribe(sessionId, handleLiveEvent);
  }, [sessionId, subscribe, handleLiveEvent]);

  const loadHistory = useCallback(async () => {
    const generation = (loadGenerationRef.current += 1);
    historyLoadedRef.current = false;
    let historySeq = 0;
    try {
      const history = await getSessionEvents(token, sessionId);
      if (generation !== loadGenerationRef.current) return;
      historySeq = history.length > 0 ? history[history.length - 1].seq : 0;
      setEvents(history.map((h) => h.event));
      setLastSeq(historySeq);
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
        historyLoadedRef.current = true;
        setHistoryLoaded(true);
        drainBufferedLiveEvents(historySeq);
      }
    }
  }, [token, sessionId, drainBufferedLiveEvents]);

  useEffect(() => {
    void loadHistory();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [loadHistory]);

  const isFirstConnect = useRef(true);
  useEffect(() => {
    if (!connected) return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    void (async () => {
      try {
        const gap = await getSessionEvents(token, sessionId, lastSeq);
        if (gap.length === 0) return;
        setEvents((prev) => [...prev, ...gap.map((g) => g.event)]);
        setLastSeq(gap[gap.length - 1].seq);
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorizedRef.current();
      }
    })();
  }, [connected]);

  function handleSend(command: Command) {
    sendCommand(sessionId, command);
  }

  if (!historyLoaded || !sessionsLoaded) {
    return <p className="text-ink-muted p-4">Loading…</p>;
  }

  const summary = sessions.find((s) => s.id === sessionId);

  if (!summary) {
    return (
      <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto">
        <p className="text-ink-muted">Session not found.</p>
        <Link to="/" className="text-link underline">
          ← Back to sessions
        </Link>
      </div>
    );
  }

  const permissionRequest = findPendingPermissionRequest(events);

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto">
      <Link to="/" className="text-sm text-link underline">
        ← Back to sessions
      </Link>

      {loadError && (
        <p role="alert" className="bg-danger-bg text-danger-text rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      <SessionStatusBar status={summary.status} projectPath={summary.projectPath} connected={connected} />

      {permissionRequest && (
        <PermissionPrompt
          sessionId={sessionId}
          requestId={permissionRequest.requestId}
          toolName={permissionRequest.toolName}
          input={permissionRequest.input}
          onSend={handleSend}
        />
      )}

      <SessionControls sessionId={sessionId} status={summary.status} onSend={handleSend} />
      <PromptInjectionBox
        sessionId={sessionId}
        disabled={summary.status === 'waiting_permission'}
        onSend={handleSend}
      />

      <div>
        <h2 className="text-sm font-semibold text-ink-muted mb-2">Modified files</h2>
        <ModifiedFilesPanel events={events} />
      </div>

      <div>
        <h2 className="text-sm font-semibold text-ink-muted mb-2">Activity</h2>
        <ActivityFeed events={events} />
      </div>
    </div>
  );
}

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
