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

  it('unwinds activeSessionId if runner.start() throws synchronously, allowing a subsequent startSession to succeed', () => {
    let callCount = 0;
    const flakyQueryFn: QueryFn = (args) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('bad cwd');
      }
      return createMockQueryFn()(args);
    };
    const manager = new SessionManager({ queryFn: flakyQueryFn, onEvent: () => {} });

    expect(() => manager.startSession('/tmp/project', 'first')).toThrow('bad cwd');
    expect(manager.getActiveSession()).toBeUndefined();

    const second = manager.startSession('/tmp/project', 'second');
    expect(manager.getActiveSession()?.id).toBe(second.id);
  });

  it('crash-terminated session self-clears the active slot without an explicit stopSession call', async () => {
    const crashingQueryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crashed')),
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    const events: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: crashingQueryFn,
      onEvent: (e) => events.push(e),
    });

    const runner = manager.startSession('/tmp/project', 'do the thing');
    expect(manager.getActiveSession()?.id).toBe(runner.id);

    // Let the crash propagate through drainMessages' catch/finalize path.
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.getActiveSession()).toBeUndefined();
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
  });
});
