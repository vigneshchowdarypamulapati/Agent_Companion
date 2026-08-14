import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSessions } from './SessionsProvider';
import { sortSessions } from './sort-sessions';
import { formatRelativeTime } from './format-relative-time';
import { STATUS_LABEL } from './SessionStatusBar';
import { getDaemonStatus } from './api/devices';
import { UnauthorizedError } from './api/sessions';
import DaemonOnboarding from './DaemonOnboarding';

export interface SessionListProps {
  token: string;
  onUnauthorized: () => void;
}

export default function SessionList({ token, onUnauthorized }: SessionListProps) {
  const { sessions, loaded, connected, loadError, dismissSession } = useSessions();
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({});
  const [daemonPaired, setDaemonPaired] = useState<boolean | undefined>(undefined);

  const sorted = sortSessions(sessions);
  const showsEmptyState = loaded && sorted.length === 0;

  useEffect(() => {
    if (!showsEmptyState) return;
    let cancelled = false;
    getDaemonStatus(token)
      .then((paired) => {
        if (!cancelled) setDaemonPaired(paired);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
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
  }, [showsEmptyState, token, onUnauthorized]);

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

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`}>
            {connected ? 'live' : 'reconnecting…'}
          </span>
          <Link to="/settings" className="text-xs text-ink-muted underline">
            Settings
          </Link>
        </div>
      </div>

      {loadError && (
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

      <ul className="space-y-2">
        {sorted.map((session) => (
          <li key={session.id} className="bg-panel rounded-md p-4">
            <Link to={`/sessions/${session.id}`} className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {STATUS_LABEL[session.status]}
                  {session.status === 'waiting_permission' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warning">Needs attention</span>
                  )}
                </p>
                <p className="text-sm text-ink-muted">{session.projectPath}</p>
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
        ))}
      </ul>
    </div>
  );
}
