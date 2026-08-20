import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { whenProjectStoreIdle } from './project-store.js';

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

async function makeManager(overrides: { maxConcurrentSessions?: number } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
  const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
  const manager = new SessionManager({
    queryFn: createMockQueryFn(),
    onEvent: () => {},
    projectStoreFilePath,
    ...overrides,
  });
  return {
    manager,
    // startSession's recordProjectUsed write is deliberately fire-and-forget in production code
    // — wait for the write queue to drain before removing tempDir, or the write's
    // mkdir/writeFile can recreate part of the directory after rm's walk has already passed it,
    // causing an intermittent ENOTEMPTY.
    cleanup: async () => {
      await whenProjectStoreIdle();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('SessionManager', () => {
  it('starts a session and it is retrievable via getSession', async () => {
    const { manager, cleanup } = await makeManager();
    try {
      const runner = manager.startSession('/tmp/project', 'do the thing');
      expect(manager.getSession(runner.id)).toBe(runner);
    } finally {
      await cleanup();
    }
  });

  it('throws when looking up an unknown session id', async () => {
    const { manager, cleanup } = await makeManager();
    try {
      expect(() => manager.getSession('does-not-exist')).toThrow();
    } finally {
      await cleanup();
    }
  });

  it('allows starting sessions up to maxConcurrentSessions', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 2 });
    try {
      const first = manager.startSession('/tmp/project-a', 'first');
      const second = manager.startSession('/tmp/project-b', 'second');
      expect(manager.getSession(first.id)).toBe(first);
      expect(manager.getSession(second.id)).toBe(second);
    } finally {
      await cleanup();
    }
  });

  it('throws when starting one more than maxConcurrentSessions', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 2 });
    try {
      manager.startSession('/tmp/project-a', 'first');
      manager.startSession('/tmp/project-b', 'second');
      expect(() => manager.startSession('/tmp/project-c', 'third')).toThrow();
    } finally {
      await cleanup();
    }
  });

  it('the cap-exceeded throw carries isCapExceeded: true so callers can distinguish it from other startSession failures', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 1 });
    try {
      manager.startSession('/tmp/project-a', 'first');
      let threw = false;
      try {
        manager.startSession('/tmp/project-b', 'second');
      } catch (err) {
        threw = true;
        expect((err as { isCapExceeded?: boolean }).isCapExceeded).toBe(true);
      }
      expect(threw).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('a stopped session no longer counts toward the cap, and is removed from the manager entirely', async () => {
    const { manager, cleanup } = await makeManager({ maxConcurrentSessions: 1 });
    try {
      const first = manager.startSession('/tmp/project', 'first');
      await manager.stopSession(first.id);

      // Removed, not merely excluded from the cap count: looking it up now throws.
      expect(() => manager.getSession(first.id)).toThrow();

      // And the freed cap slot is real, not just a count that happens to be right.
      const second = manager.startSession('/tmp/project', 'second');
      expect(manager.getSession(second.id)).toBe(second);
    } finally {
      await cleanup();
    }
  });

  it('unwinds on a synchronous runner.start() failure, and does not count the failed attempt toward the cap', async () => {
    let callCount = 0;
    const flakyQueryFn: QueryFn = (args) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('bad cwd');
      }
      return createMockQueryFn()(args);
    };
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
    const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
    const manager = new SessionManager({
      queryFn: flakyQueryFn,
      onEvent: () => {},
      projectStoreFilePath,
      maxConcurrentSessions: 1,
    });
    try {
      expect(() => manager.startSession('/tmp/project', 'first')).toThrow('bad cwd');

      const second = manager.startSession('/tmp/project', 'second');
      expect(manager.getSession(second.id)).toBe(second);
    } finally {
      // The successful second startSession call above has a fire-and-forget recordProjectUsed
      // write in flight — wait for it before removing tempDir (see makeManager's cleanup for why).
      await whenProjectStoreIdle();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('a crash-terminated session is removed from the manager without an explicit stopSession call', async () => {
    const crashingQueryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crashed')),
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    const events: SessionEvent[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
    const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
    const manager = new SessionManager({
      queryFn: crashingQueryFn,
      onEvent: (e) => events.push(e),
      projectStoreFilePath,
    });
    try {
      const runner = manager.startSession('/tmp/project', 'do the thing');
      expect(manager.getSession(runner.id)).toBe(runner);

      // Let the crash propagate through drainMessages' catch/finalize path.
      await new Promise((resolve) => setImmediate(resolve));

      expect(() => manager.getSession(runner.id)).toThrow();
      expect(events.some((e) => e.type === 'stopped')).toBe(true);
    } finally {
      // startSession's fire-and-forget recordProjectUsed write is in flight — wait for it before
      // removing tempDir (see makeManager's cleanup for why).
      await whenProjectStoreIdle();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('records the project path as used on a successful start', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-session-manager-test-'));
    const projectStoreFilePath = join(tempDir, 'daemon-projects.json');
    const manager = new SessionManager({
      queryFn: createMockQueryFn(),
      onEvent: () => {},
      projectStoreFilePath,
    });
    try {
      manager.startSession('/tmp/my-project', 'do the thing');

      // The record is fire-and-forget (startSession never awaits it), and involves real
      // mkdir/read/write filesystem I/O rather than just a microtask hop — a single
      // setImmediate/tick is not reliably enough time for it to land. Poll instead of
      // guessing a fixed delay.
      const { listKnownProjects } = await import('./project-store.js');
      const deadline = Date.now() + 2000;
      let known: Awaited<ReturnType<typeof listKnownProjects>> = [];
      while (Date.now() < deadline) {
        known = await listKnownProjects({ filePath: projectStoreFilePath });
        if (known.some((p) => p.path === '/tmp/my-project')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(known.map((p) => p.path)).toContain('/tmp/my-project');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
