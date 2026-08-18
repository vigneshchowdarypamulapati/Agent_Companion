import type { SessionStatus } from '@companion/protocol';
import type { ConnectionState } from './use-relay-connection';

export interface SessionStatusBarProps {
  status: SessionStatus;
  projectPath: string;
  connectionState: ConnectionState;
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  running: 'Running',
  waiting_permission: 'Waiting for permission',
  waiting_input: 'Waiting for you',
  paused: 'Paused',
  stopped: 'Stopped',
};

/**
 * Every "live" indicator in the app (here and SessionList) renders through this one component,
 * fed the same ConnectionState — so there is exactly one place that decides what each state
 * looks like, and no badge can claim "live" on its own say-so.
 */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  offline: 'offline',
};

const CONNECTION_BADGE_CLASS: Record<ConnectionState, string> = {
  connecting: 'bg-border text-ink-secondary',
  live: 'bg-success',
  reconnecting: 'bg-danger',
  offline: 'bg-warning',
};

export function ConnectionBadge({ connectionState }: { connectionState: ConnectionState }) {
  return (
    <span className={`text-xs px-2 py-1 rounded-full ${CONNECTION_BADGE_CLASS[connectionState]}`}>
      {CONNECTION_LABEL[connectionState]}
    </span>
  );
}

export default function SessionStatusBar({ status, projectPath, connectionState }: SessionStatusBarProps) {
  return (
    <div className="flex items-center justify-between bg-panel rounded-md px-4 py-3">
      <div>
        <p className="font-medium">{STATUS_LABEL[status]}</p>
        <p className="text-sm text-ink-muted">{projectPath}</p>
      </div>
      <ConnectionBadge connectionState={connectionState} />
    </div>
  );
}
