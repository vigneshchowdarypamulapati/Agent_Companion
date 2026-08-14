import type { SessionStatus } from '@companion/protocol';

export interface SessionStatusBarProps {
  status: SessionStatus;
  projectPath: string;
  connected: boolean;
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  waiting_permission: 'Waiting for permission',
  waiting_input: 'Waiting for you',
  paused: 'Paused',
  stopped: 'Stopped',
};

export default function SessionStatusBar({ status, projectPath, connected }: SessionStatusBarProps) {
  return (
    <div className="flex items-center justify-between bg-panel rounded-md px-4 py-3">
      <div>
        <p className="font-medium">{STATUS_LABEL[status]}</p>
        <p className="text-sm text-ink-muted">{projectPath}</p>
      </div>
      <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`}>
        {connected ? 'live' : 'reconnecting…'}
      </span>
    </div>
  );
}
