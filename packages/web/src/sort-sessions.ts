import type { SessionSummary } from './use-sessions-store';

/**
 * Sessions waiting on a permission decision always sort first, regardless of
 * activity time — that's the one state where being buried below the fold
 * means a missed decision. Within a tier, most-recently-active first.
 */
export function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    const aWaiting = a.status === 'waiting_permission';
    const bWaiting = b.status === 'waiting_permission';
    if (aWaiting !== bWaiting) return aWaiting ? -1 : 1;
    return b.lastEventAt - a.lastEventAt;
  });
}
