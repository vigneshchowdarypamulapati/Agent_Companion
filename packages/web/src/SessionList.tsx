import { useState } from 'react';
import { Link } from 'react-router';
import { useSessions } from './SessionsProvider';
import { sortSessions } from './sort-sessions';
import { formatRelativeTime } from './format-relative-time';
import { STATUS_LABEL } from './SessionStatusBar';

export default function SessionList() {
  const { sessions, loaded, connected, loadError, dismissSession } = useSessions();
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({});

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
    return <p className="text-slate-400 p-4">Loading…</p>;
  }

  const sorted = sortSessions(sessions);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-700' : 'bg-red-700'}`}>
            {connected ? 'live' : 'reconnecting…'}
          </span>
          <Link to="/settings" className="text-xs text-slate-400 underline">
            Settings
          </Link>
        </div>
      </div>

      {loadError && (
        <p role="alert" className="bg-red-900 text-red-100 rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      {sorted.length === 0 && <p className="text-slate-400">No active sessions.</p>}

      <ul className="space-y-2">
        {sorted.map((session) => (
          <li key={session.id} className="bg-slate-800 rounded-md p-4">
            <Link to={`/sessions/${session.id}`} className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {STATUS_LABEL[session.status]}
                  {session.status === 'waiting_permission' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-700">Needs attention</span>
                  )}
                </p>
                <p className="text-sm text-slate-400">{session.projectPath}</p>
              </div>
              <span className="text-xs text-slate-500">{formatRelativeTime(session.lastEventAt)}</span>
            </Link>
            {session.status === 'stopped' && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => handleDismiss(session.id)}
                  className="text-xs px-3 py-1 rounded-md bg-slate-700"
                >
                  Dismiss
                </button>
                {dismissErrors[session.id] && (
                  <p role="alert" className="text-xs text-red-400 mt-1">
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
