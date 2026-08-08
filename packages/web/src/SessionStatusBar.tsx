import type { SessionStatus } from '@companion/protocol';

export interface SessionStatusBarProps {
  status: SessionStatus | 'none';
  projectPath?: string;
  connected: boolean;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  waiting_permission: 'Waiting for permission',
  paused: 'Paused',
  stopped: 'Stopped',
};

export default function SessionStatusBar({ status, projectPath, connected }: SessionStatusBarProps) {
  return (
    <div className="flex items-center justify-between bg-slate-800 rounded-md px-4 py-3">
      <div>
        {status === 'none' ? (
          <p className="font-medium">No Active Sessions</p>
        ) : (
          <>
            <p className="font-medium">{STATUS_LABEL[status]}</p>
            {projectPath && <p className="text-sm text-slate-400">{projectPath}</p>}
          </>
        )}
      </div>
      <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-green-700' : 'bg-red-700'}`}>
        {connected ? 'live' : 'reconnecting…'}
      </span>
    </div>
  );
}
