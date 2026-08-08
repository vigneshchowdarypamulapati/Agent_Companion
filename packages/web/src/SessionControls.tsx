import type { Command, SessionStatus } from '@companion/protocol';

export interface SessionControlsProps {
  sessionId: string;
  status: SessionStatus;
  onSend: (command: Command) => void;
}

export default function SessionControls({ sessionId, status, onSend }: SessionControlsProps) {
  const canPause = status === 'running';
  const canResume = status === 'paused';
  const canStop = status !== 'stopped';

  return (
    <div className="flex gap-2">
      <button
        type="button"
        disabled={!canPause}
        onClick={() => onSend({ type: 'pause', sessionId })}
        className="flex-1 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        Pause
      </button>
      <button
        type="button"
        disabled={!canResume}
        onClick={() => onSend({ type: 'resume', sessionId })}
        className="flex-1 rounded-md bg-slate-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        Resume
      </button>
      <button
        type="button"
        disabled={!canStop}
        onClick={() => onSend({ type: 'stop', sessionId })}
        className="flex-1 rounded-md bg-red-800 px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        Stop
      </button>
    </div>
  );
}
