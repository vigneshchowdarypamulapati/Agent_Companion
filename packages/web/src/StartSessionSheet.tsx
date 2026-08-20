import { useEffect, useState } from 'react';
import { useSessions } from './SessionsProvider';
import { RpcError } from './relay-connection';
import ProjectPicker, { type ProjectListEntry } from './ProjectPicker';
import { formatRelativeTime } from './format-relative-time';

export interface StartSessionSheetProps {
  onStarted: (sessionId: string) => void;
  onClose: () => void;
}

interface DiscoveredSession {
  sessionId: string;
  summary: string;
  firstPrompt: string | undefined;
  lastModified: number;
}

/**
 * Only tracks how far the user has gotten picking a project — never the prompt itself or the
 * outcome of submitting it. Once a project is picked, `PromptStep` below owns the rest of its own
 * lifecycle (typed text, in-flight state, last error) exactly the way `PromptInjectionBox` owns
 * `sendState`: because that state lives in a component that stays mounted across a failed submit,
 * "don't lose what the user typed" falls out for free from React just never unmounting it, rather
 * than this component having to thread `project`/`prompt` through an `'error'` phase and risk
 * carrying stale copies of either.
 */
type Phase =
  | { step: 'loading-projects' }
  | { step: 'load-error'; message: string }
  | { step: 'picking'; projects: ProjectListEntry[] }
  | { step: 'checking-sessions'; project: ProjectListEntry }
  | { step: 'choosing-session'; project: ProjectListEntry; sessions: DiscoveredSession[] }
  | { step: 'prompting'; project: ProjectListEntry };

const DEFAULT_ERROR_MESSAGE = 'Something went wrong starting the session. Try again.';

export default function StartSessionSheet({ onStarted, onClose }: StartSessionSheetProps) {
  const { callDaemon } = useSessions();
  const [phase, setPhase] = useState<Phase>({ step: 'loading-projects' });

  useEffect(() => {
    let cancelled = false;
    callDaemon('list_projects')
      .then((result) => {
        if (!cancelled) setPhase({ step: 'picking', projects: result as ProjectListEntry[] });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof RpcError ? err.message : DEFAULT_ERROR_MESSAGE;
        setPhase({ step: 'load-error', message });
      });
    return () => {
      cancelled = true;
    };
  }, [callDaemon]);

  function handleSelectProject(project: ProjectListEntry) {
    setPhase({ step: 'checking-sessions', project });
    callDaemon('list_discoverable_sessions', { projectPath: project.path })
      .then((result) => {
        const sessions = result as DiscoveredSession[];
        if (sessions.length === 0) {
          setPhase({ step: 'prompting', project });
        } else {
          setPhase({ step: 'choosing-session', project, sessions });
        }
      })
      .catch(() => {
        // Discovery is a convenience, never a blocking requirement — unlike list_projects
        // above, whose failure surfaces as load-error, a failed discovery call fails silently
        // toward the normal fresh-start prompt so the user is never blocked from starting a
        // session just because discovery couldn't run.
        setPhase({ step: 'prompting', project });
      });
  }

  return (
    <div role="dialog" aria-label="Start a session" className="fixed inset-0 z-10 flex items-end justify-center bg-black/40">
      <div className="w-full max-w-lg bg-canvas rounded-t-xl p-4 space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Start a session</h2>
          <button type="button" onClick={onClose} className="text-sm text-ink-muted underline">
            Cancel
          </button>
        </div>

        {phase.step === 'loading-projects' && <p className="text-ink-muted">Loading projects…</p>}

        {phase.step === 'load-error' && (
          <p role="alert" className="text-sm text-danger-light">
            {phase.message}
          </p>
        )}

        {phase.step === 'picking' && (
          <ProjectPicker projects={phase.projects} onSelect={handleSelectProject} />
        )}

        {phase.step === 'checking-sessions' && <p className="text-ink-muted">Checking for existing sessions…</p>}

        {phase.step === 'choosing-session' && (
          <ChoosingSessionStep
            project={phase.project}
            sessions={phase.sessions}
            callDaemon={callDaemon}
            onStarted={onStarted}
            onStartNew={() => setPhase({ step: 'prompting', project: phase.project })}
          />
        )}

        {phase.step === 'prompting' && (
          <PromptStep project={phase.project} callDaemon={callDaemon} onStarted={onStarted} />
        )}
      </div>
    </div>
  );
}

interface ChoosingSessionStepProps {
  project: ProjectListEntry;
  sessions: DiscoveredSession[];
  callDaemon: (method: string, params?: unknown) => Promise<unknown>;
  onStarted: (sessionId: string) => void;
  onStartNew: () => void;
}

/**
 * `adopt_session` is 'idle' | 'pending' — analogous to `PromptStep`'s `text`/{@link SubmitState}. */
type AdoptState =
  | { phase: 'idle' }
  | { phase: 'pending'; sessionId: string }
  | { phase: 'error'; sessionId: string; message: string };

/**
 * Owns the choosing-session phase end to end, mirroring `PromptStep`'s self-contained
 * pending/error lifecycle below. Two things fall out of that mirroring for free:
 *
 * - A failed `adopt_session` call (e.g. SESSION_NOT_FOUND because the original session vanished
 *   between discovery and the tap) surfaces its real message via a `role="alert"` element and
 *   stays on this phase — the user can retry a different row or fall back to "start a new session
 *   instead". It never silently teleports to a blank prompt step the way the old inline
 *   `.catch(() => setPhase(...))` did, which made the whole point of a distinct SESSION_NOT_FOUND
 *   message dead code.
 * - `pending` disables every row and the "start new" button and shows "Starting…" on the row
 *   being adopted, closing the same double-tap hazard `PromptStep`'s submit button already
 *   guards against: without it, a double-tap fires two `adopt_session` calls, forks two sessions,
 *   and orphans the second one silently.
 */
function ChoosingSessionStep({ project, sessions, callDaemon, onStarted, onStartNew }: ChoosingSessionStepProps) {
  const [adoptState, setAdoptState] = useState<AdoptState>({ phase: 'idle' });

  const pending = adoptState.phase === 'pending';

  function adopt(sessionId: string) {
    if (pending) return;
    setAdoptState({ phase: 'pending', sessionId });
    callDaemon('adopt_session', { projectPath: project.path, sessionId })
      .then((result) => {
        const { id } = result as { id: string; status: string };
        onStarted(id);
      })
      .catch((err) => {
        const message = err instanceof RpcError ? err.message : DEFAULT_ERROR_MESSAGE;
        setAdoptState({ phase: 'error', sessionId, message });
      });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        Found {sessions.length} existing session{sessions.length === 1 ? '' : 's'} in {project.displayName}
      </p>
      <ul className="space-y-1 max-h-64 overflow-y-auto">
        {sessions.map((session) => {
          const isAdoptingThisRow = adoptState.phase === 'pending' && adoptState.sessionId === session.sessionId;
          return (
            <li key={session.sessionId}>
              <button
                type="button"
                disabled={pending}
                onClick={() => adopt(session.sessionId)}
                className="w-full text-left rounded-md bg-panel hover:bg-border px-3 py-2 disabled:opacity-50"
              >
                <span className="font-medium">{session.summary}</span>
                {session.firstPrompt && (
                  <p className="text-xs text-ink-faint truncate">{session.firstPrompt}</p>
                )}
                <p className="text-xs text-ink-muted">
                  {isAdoptingThisRow ? 'Starting…' : `Last active ${formatRelativeTime(session.lastModified)}`}
                </p>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        disabled={pending}
        onClick={onStartNew}
        className="w-full text-left rounded-md bg-panel hover:bg-border px-3 py-2 text-sm text-ink-muted underline disabled:opacity-50"
      >
        Start a new session instead
      </button>
      {adoptState.phase === 'error' && (
        <p role="alert" className="text-sm text-danger-light">
          {adoptState.message}
        </p>
      )}
    </div>
  );
}

interface PromptStepProps {
  project: ProjectListEntry;
  callDaemon: (method: string, params?: unknown) => Promise<unknown>;
  onStarted: (sessionId: string) => void;
}

type SubmitState = { phase: 'idle' } | { phase: 'pending' } | { phase: 'error'; message: string };

/**
 * Mirrors PromptInjectionBox's "never discard typed input on failure" pattern: `text` and
 * `submitState` both live here, so a failed `start_session` call leaves the textarea exactly as
 * the user left it — there's no parent-owned copy that could go stale, and switching back from an
 * error to a fresh submit just keeps editing this same `text` state rather than losing anything.
 */
function PromptStep({ project, callDaemon, onStarted }: PromptStepProps) {
  const [text, setText] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>({ phase: 'idle' });

  const pending = submitState.phase === 'pending';

  function submit(value: string) {
    setSubmitState({ phase: 'pending' });
    callDaemon('start_session', { projectPath: project.path, prompt: value })
      .then((result) => {
        const { id } = result as { id: string; status: string };
        onStarted(id);
      })
      .catch((err) => {
        const message = err instanceof RpcError ? err.message : DEFAULT_ERROR_MESSAGE;
        setSubmitState({ phase: 'error', message });
      });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || pending) return;
        submit(text);
      }}
      className="space-y-2"
    >
      <p className="text-sm text-ink-muted">{project.displayName}</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should Claude do?"
        aria-label="What should Claude do?"
        rows={3}
        className="w-full rounded-md bg-panel px-3 py-2"
      />
      <button
        type="submit"
        disabled={pending || text.trim().length === 0}
        className="w-full rounded-md bg-accent hover:bg-accent-hover px-3 py-2 font-medium disabled:opacity-50"
      >
        {pending ? 'Starting…' : 'Start'}
      </button>
      {submitState.phase === 'error' && (
        <p role="alert" className="text-sm text-danger-light">
          {submitState.message}
        </p>
      )}
    </form>
  );
}
