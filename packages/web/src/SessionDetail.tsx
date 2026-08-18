import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router';
import type { Command, SessionEvent } from '@companion/protocol';
import { getSessionEvents, UnauthorizedError } from './api/sessions';
import { useSessions } from './SessionsProvider';
import type { CommandAckResult, LiveEvent } from './use-relay-connection';
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
  const { sessions, loaded: sessionsLoaded, connectionState, sendCommand, subscribe } = useSessions();

  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  // Mirrors lastSeq so the reconnect gap-fill can compare against the value as of when its
  // response lands, not the one captured when the effect ran — same ref-mirror pattern as
  // onUnauthorizedRef below.
  const lastSeqRef = useRef(0);
  lastSeqRef.current = lastSeq;
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
    if (connectionState !== 'live') return;
    if (isFirstConnect.current) {
      isFirstConnect.current = false;
      return;
    }
    void (async () => {
      try {
        const gap = await getSessionEvents(token, sessionId, lastSeqRef.current);
        if (gap.length === 0) return;
        // The fetch is not atomic with the live stream: events can arrive over the socket
        // while it is in flight, so the response may overlap what we already applied.
        // Filtering against the live ref (rather than the `lastSeq` captured when this
        // effect ran) is what stops a reconnect from duplicate-appending, and taking a
        // max stops it from regressing lastSeq below a newer live event.
        const fresh = gap.filter((g) => g.seq > lastSeqRef.current);
        if (fresh.length === 0) return;
        setEvents((prev) => [...prev, ...fresh.map((g) => g.event)]);
        setLastSeq((prev) => Math.max(prev, fresh[fresh.length - 1].seq));
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorizedRef.current();
      }
    })();
  }, [connectionState]);

  // Shared by SessionControls and PermissionPrompt (which ignore the returned promise — they
  // have no pending/retry UI of their own) and PromptInjectionBox (which awaits it to drive its
  // pending/error/retry state — see that component for why the reply box specifically must
  // never clear the user's typed text until this resolves 'delivered').
  function handleSend(command: Command): Promise<CommandAckResult> {
    return sendCommand(sessionId, command);
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
  const lastAssistantText = summary.status === 'waiting_input' ? findLastAssistantText(events) : undefined;

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto">
      <Link to="/" className="text-sm text-link underline">
        ← Back to sessions
      </Link>

      {/*
       * Suppressed while offline rather than shown with different copy: `loadError` is the raw
       * message from a failed fetch, and when the device itself has no network that message is
       * always something like "Failed to fetch" — a fetch-layer artifact of the browser giving up,
       * not a fact about the relay. Rendering it (even reworded) would still imply this screen has
       * something specific to say about why the *relay* failed, when it has no idea — the device
       * never got far enough to find out. The ConnectionBadge below already says "offline" from
       * navigator.onLine, which is the honest, correctly-sourced signal for this condition, so the
       * banner would be redundant at best and relay-blaming at worst. A genuine relay failure while
       * the device IS online (connectionState is 'connecting' or 'reconnecting', not 'offline')
       * still hits this branch and renders normally — only the offline case is swallowed.
       */}
      {loadError && connectionState !== 'offline' && (
        <p role="alert" className="bg-danger-bg text-danger-text rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      <SessionStatusBar status={summary.status} projectPath={summary.projectPath} connectionState={connectionState} />

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

      {lastAssistantText && (
        <div className="bg-panel rounded-md px-4 py-3">
          <p className="text-xs font-medium text-ink-muted mb-1">Claude is waiting for your reply</p>
          <p className="text-sm">{lastAssistantText}</p>
        </div>
      )}

      <PromptInjectionBox
        sessionId={sessionId}
        disabled={summary.status === 'waiting_permission'}
        placeholder={summary.status === 'waiting_input' ? "What's next?" : undefined}
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

function findLastAssistantText(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'assistant_text') return event.text;
    if (event.type === 'turn_complete' && i < events.length - 1) return undefined;
  }
  return undefined;
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
