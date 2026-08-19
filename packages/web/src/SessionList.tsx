import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useSessions } from './SessionsProvider';
import { sortSessions } from './sort-sessions';
import { formatRelativeTime } from './format-relative-time';
import { ConnectionBadge } from './SessionStatusBar';
import { getDaemonStatus } from './api/devices';
import { UnauthorizedError } from './api/sessions';
import DaemonOnboarding from './DaemonOnboarding';
import { colorForProject } from './project-color';
import StartSessionSheet from './StartSessionSheet';
import type { SessionSummary } from './use-sessions-store';

export interface SessionListProps {
  token: string;
  onUnauthorized: () => void;
}

export default function SessionList({ token, onUnauthorized }: SessionListProps) {
  const { sessions, loaded, connectionState, loadError, dismissSession } = useSessions();
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({});
  const [daemonPaired, setDaemonPaired] = useState<boolean | undefined>(undefined);
  const [showStartSheet, setShowStartSheet] = useState(false);
  const navigate = useNavigate();
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const sorted = sortSessions(sessions);
  const showsEmptyState = loaded && sorted.length === 0;

  useEffect(() => {
    if (!showsEmptyState) return;
    let cancelled = false;
    getDaemonStatus(token)
      .then((status) => {
        if (!cancelled) setDaemonPaired(status.paired);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorizedRef.current();
          return;
        }
        // A daemon-status check failing should never block or mislead a
        // new user — fail toward showing onboarding rather than silently
        // falling back to the unhelpful blank "No active sessions." text.
        setDaemonPaired(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showsEmptyState, token]);

  async function handleDismiss(sessionId: string) {
    setDismissErrors((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      await dismissSession(sessionId);
    } catch (err) {
      setDismissErrors((prev) => ({ ...prev, [sessionId]: err instanceof Error ? err.message : String(err) }));
    }
  }

  if (!loaded) {
    return <p className="text-ink-muted p-4">Loading…</p>;
  }

  // Paused sessions sit alongside waiting_permission/waiting_input in "Needs you": a pause is a
  // deliberate user action (SessionControls) and the session stays idle until the user resumes or
  // stops it — closer in spirit to "owes the user a decision" than to either "actively running" or
  // "finished."
  const needsYou = sorted.filter(
    (s) => s.status === 'waiting_permission' || s.status === 'waiting_input' || s.status === 'paused'
  );
  const running = sorted.filter((s) => s.status === 'running');
  const stopped = sorted.filter((s) => s.status === 'stopped');

  function renderCard(session: SessionSummary) {
    const displayName = session.projectPath.split(/[/\\]/).filter(Boolean).pop() ?? session.projectPath;
    return (
      <li key={session.id} className="bg-panel rounded-md p-4">
        <Link to={`/sessions/${session.id}`} className="flex items-center justify-between">
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className="mt-1.5 h-2 w-2 rounded-full shrink-0"
              style={{ backgroundColor: colorForProject(session.projectPath) }}
            />
            <div>
              <p className="font-medium">
                {displayName}
                {session.status === 'waiting_permission' && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warning">Needs attention</span>
                )}
                {session.status === 'waiting_input' && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-accent">Your turn</span>
                )}
                {session.status === 'paused' && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-border">Paused</span>
                )}
              </p>
              <p className="text-sm text-ink-muted">{session.projectPath}</p>
            </div>
          </div>
          <span className="text-xs text-ink-faint">{formatRelativeTime(session.lastEventAt)}</span>
        </Link>
        {session.status === 'stopped' && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => handleDismiss(session.id)}
              className="text-xs px-3 py-1 rounded-md bg-border"
            >
              Dismiss
            </button>
            {dismissErrors[session.id] && (
              <p role="alert" className="text-xs text-danger-light mt-1">
                {dismissErrors[session.id]}
              </p>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto pb-24">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          <ConnectionBadge connectionState={connectionState} />
          <Link to="/settings" className="text-xs text-ink-muted underline">
            Settings
          </Link>
        </div>
      </div>

      {/* See SessionDetail.tsx's identical guard for why this is suppressed (not reworded) while
       * offline: `loadError` is a raw fetch-failure message ("Failed to fetch"), not a relay
       * diagnosis, and the ConnectionBadge above already reports "offline" from the honest source
       * (navigator.onLine). A real relay failure while online still renders here as before. */}
      {loadError && connectionState !== 'offline' && (
        <p role="alert" className="bg-danger-bg text-danger-text rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      {showsEmptyState &&
        (daemonPaired === false ? (
          <DaemonOnboarding token={token} onUnauthorized={onUnauthorized} />
        ) : daemonPaired === true ? (
          <p className="text-ink-muted">No active sessions.</p>
        ) : null)}

      {needsYou.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-ink-muted mb-2">Needs you</h2>
          <ul className="space-y-2">{needsYou.map(renderCard)}</ul>
        </section>
      )}

      {running.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-ink-muted mb-2">Running</h2>
          <ul className="space-y-2">{running.map(renderCard)}</ul>
        </section>
      )}

      {stopped.length > 0 && (
        <details>
          <summary className="text-sm font-semibold text-ink-muted mb-2 cursor-pointer">
            Stopped ({stopped.length})
          </summary>
          <ul className="space-y-2">{stopped.map(renderCard)}</ul>
        </details>
      )}

      <button
        type="button"
        onClick={() => setShowStartSheet(true)}
        aria-label="Start a session"
        className="fixed bottom-6 right-6 h-14 w-14 rounded-full bg-accent hover:bg-accent-hover text-2xl font-medium shadow-lg flex items-center justify-center"
      >
        +
      </button>

      {showStartSheet && (
        <StartSessionSheet
          onStarted={(sessionId) => {
            setShowStartSheet(false);
            navigate(`/sessions/${sessionId}`);
          }}
          onClose={() => setShowStartSheet(false)}
        />
      )}
    </div>
  );
}
