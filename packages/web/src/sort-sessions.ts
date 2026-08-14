import type { SessionSummary } from './use-sessions-store';

/**
 * Sessions where the user owes a response sort ahead of everything else,
 * within their own two-tier priority: a session actually blocked on a
 * permission decision (potentially time-sensitive) outranks one where
 * Claude simply finished a turn and is idle waiting for the next
 * instruction (less urgent — nothing is stuck). Within a tier, most
 * recently active first.
 */
function priority(status: SessionSummary['status']): number {
  if (status === 'waiting_permission') return 0;
  if (status === 'waiting_input') return 1;
  return 2;
}

export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const diff = priority(a.status) - priority(b.status);
    if (diff !== 0) return diff;
    return b.lastEventAt - a.lastEventAt;
  });
}
