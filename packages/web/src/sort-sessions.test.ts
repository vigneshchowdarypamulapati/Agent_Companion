import { describe, it, expect } from 'vitest';
import { sortSessions } from './sort-sessions';
import type { SessionSummary } from './use-sessions-store';

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return { id: 'sess', projectPath: '/tmp', status: 'running', lastEventAt: 0, ...overrides };
}

describe('sortSessions', () => {
  it('puts waiting_permission sessions ahead of everything else', () => {
    const sessions = [
      session({ id: 'a', status: 'running', lastEventAt: 100 }),
      session({ id: 'b', status: 'waiting_permission', lastEventAt: 1 }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('sorts within a tier by lastEventAt descending', () => {
    const sessions = [session({ id: 'old', lastEventAt: 1 }), session({ id: 'new', lastEventAt: 100 })];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('puts waiting_input sessions ahead of running ones, but behind waiting_permission', () => {
    const sessions = [
      session({ id: 'a', status: 'running', lastEventAt: 100 }),
      session({ id: 'b', status: 'waiting_input', lastEventAt: 1 }),
      session({ id: 'c', status: 'waiting_permission', lastEventAt: 1 }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts within the waiting_input tier by lastEventAt descending', () => {
    const sessions = [
      session({ id: 'old', status: 'waiting_input', lastEventAt: 1 }),
      session({ id: 'new', status: 'waiting_input', lastEventAt: 100 }),
    ];
    expect(sortSessions(sessions).map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('does not mutate the input array', () => {
    const sessions = [session({ id: 'a', lastEventAt: 1 }), session({ id: 'b', lastEventAt: 2 })];
    const original = [...sessions];
    sortSessions(sessions);
    expect(sessions).toEqual(original);
  });
});
