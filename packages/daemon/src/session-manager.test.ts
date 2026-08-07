import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

function createMockQueryFn(): QueryFn {
  return () => {
    const outgoing = new AsyncQueue<AgentMessage>();
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => outgoing.close()),
    };
    return agentQuery;
  };
}

describe('SessionManager', () => {
  it('starts a session and makes it the active session', () => {
    const events: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: createMockQueryFn(),
      onEvent: (e) => events.push(e),
    });

    const runner = manager.startSession('/tmp/project', 'do the thing');

    expect(manager.getActiveSession()?.id).toBe(runner.id);
    expect(manager.getSession(runner.id)).toBe(runner);
  });

  it('throws when starting a second session while one is active', () => {
    const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {} });

    manager.startSession('/tmp/project', 'first');

    expect(() => manager.startSession('/tmp/project', 'second')).toThrow();
  });

  it('throws when looking up an unknown session id', () => {
    const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {} });
    expect(() => manager.getSession('does-not-exist')).toThrow();
  });

  it('clears the active slot after stopSession, allowing a new session to start', async () => {
    const manager = new SessionManager({ queryFn: createMockQueryFn(), onEvent: () => {} });

    const first = manager.startSession('/tmp/project', 'first');
    await manager.stopSession(first.id);

    expect(manager.getActiveSession()).toBeUndefined();

    const second = manager.startSession('/tmp/project', 'second');
    expect(manager.getActiveSession()?.id).toBe(second.id);
  });
});
