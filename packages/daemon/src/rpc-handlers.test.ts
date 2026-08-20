import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchRpc, type RpcHandler, type RpcHandlerDeps } from './rpc-handlers.js';
import { RPC_ERROR_CODES } from '@companion/protocol';
import { SessionManager } from './session-manager.js';
import { AsyncQueue } from './async-queue.js';
import type { AgentMessage, AgentQuery, QueryFn } from './agent-sdk-port.js';
import { recordProjectUsed, whenProjectStoreIdle } from './project-store.js';

function createMockQueryFn(): QueryFn {
  return () => {
    const outgoing = new AsyncQueue<AgentMessage>();
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt: async () => {},
      close: () => outgoing.close(),
    };
    return agentQuery;
  };
}

/** A QueryFn whose returned AgentQuery throws synchronously as soon as SessionRunner iterates it
 * — mirrors the pattern Task 3's own tests use to force `runner.start()` to fail without going
 * through the real cap-exceeded path, so we can prove a genuine runner-start failure is NOT
 * mislabeled as CONCURRENT_SESSION_LIMIT (Correction 1). */
function createThrowingQueryFn(): QueryFn {
  return () => {
    throw new Error('synthetic runner-start failure, not a capacity issue');
  };
}

// Existing tests below only ever exercise `ping` or an injected throwing/void registry — they
// never touch `manager` or `projectStoreFilePath` — so a placeholder SessionManager cast is safe
// here; it just satisfies RpcHandlerDeps now that those fields are required.
const baseDeps: RpcHandlerDeps = {
  version: '1.2.3',
  startedAt: 0,
  manager: {} as unknown as SessionManager,
  projectStoreFilePath: '/dev/null/companion-rpc-handlers-test-unused',
  projectsRoot: undefined,
};

describe('dispatchRpc', () => {
  it('ping returns the daemon version and uptime computed from startedAt', async () => {
    const outcome = await dispatchRpc('ping', undefined, {
      ...baseDeps,
      version: '1.2.3',
      startedAt: 1000,
      now: () => 1500,
    });
    expect(outcome).toEqual({ result: { version: '1.2.3', uptimeMs: 500 } });
  });

  it('returns a typed unknown_method error for a method with no registered handler', async () => {
    const outcome = await dispatchRpc('does-not-exist', undefined, baseDeps);
    expect(outcome).toEqual({ error: 'unknown_method' });
  });

  it('returns a typed handler_error result instead of throwing when a handler throws', async () => {
    const throwingRegistry: Record<string, RpcHandler> = {
      broken: () => {
        throw new Error('boom');
      },
    };
    const outcome = await dispatchRpc('broken', undefined, baseDeps, throwingRegistry);
    expect(outcome).toEqual({ error: 'handler_error' });
  });

  it('returns a typed handler_error result when an async handler rejects', async () => {
    const rejectingRegistry: Record<string, RpcHandler> = {
      broken: async () => {
        throw new Error('boom');
      },
    };
    const outcome = await dispatchRpc('broken', undefined, baseDeps, rejectingRegistry);
    expect(outcome).toEqual({ error: 'handler_error' });
  });

  it('normalizes an undefined handler return value to null, never an absent result', async () => {
    const voidRegistry: Record<string, RpcHandler> = {
      noop: () => undefined,
    };
    const outcome = await dispatchRpc('noop', undefined, baseDeps, voidRegistry);
    expect(outcome).toEqual({ result: null });
    expect('result' in outcome).toBe(true);
  });
});

describe('rpc-handlers: list_projects / start_session', () => {
  it('list_projects returns known projects sorted most-recently-used first', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    // resolveKnownProjects filters history entries by on-disk existence (see the dedicated
    // "excludes a known path that no longer exists" test below), so this sort-order test needs
    // real directories to survive that filter — the brief's own reference test used bare
    // '/tmp/older' / '/tmp/newer' literals, which are not real directories on every platform
    // (notably Windows, where the leading '/' resolves relative to the current drive, e.g.
    // 'D:\tmp\older', not a real path) and got silently dropped by the existence check, making the
    // test fail for a reason unrelated to what it's actually verifying (sort order).
    const olderDir = join(tempDir, 'older');
    const newerDir = join(tempDir, 'newer');
    await mkdir(olderDir);
    await mkdir(newerDir);
    try {
      await recordProjectUsed(olderDir, { filePath, now: () => 1000 });
      await recordProjectUsed(newerDir, { filePath, now: () => 2000 });
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toEqual([
        { path: newerDir, displayName: 'newer', source: 'history', lastUsedAt: 2000 },
        { path: olderDir, displayName: 'older', source: 'history', lastUsedAt: 1000 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('list_projects excludes a known path that no longer exists on disk', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const realProjectDir = join(tempDir, 'still-here');
    await mkdir(realProjectDir);
    try {
      await recordProjectUsed(realProjectDir, { filePath, now: () => 1000 });
      await recordProjectUsed('/tmp/deleted-project-path-does-not-exist', { filePath, now: () => 2000 });
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      const paths = (outcome.result as { path: string }[]).map((p) => p.path);
      expect(paths).toEqual([realProjectDir]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('list_projects includes subdirectories of projectsRoot with source "configured" when never used', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectsRoot = join(tempDir, 'root');
    await mkdir(join(projectsRoot, 'brand-new-project'), { recursive: true });
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot,
      });

      expect(outcome.result).toEqual([
        {
          path: join(projectsRoot, 'brand-new-project'),
          displayName: 'brand-new-project',
          source: 'configured',
          lastUsedAt: undefined,
        },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('a path both in history and under projectsRoot is reported once, as "history"', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectsRoot = join(tempDir, 'root');
    const usedProjectDir = join(projectsRoot, 'used-project');
    await mkdir(usedProjectDir, { recursive: true });
    try {
      await recordProjectUsed(usedProjectDir, { filePath, now: () => 1000 });
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('list_projects', null, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot,
      });

      expect(outcome.result).toEqual([
        { path: usedProjectDir, displayName: 'used-project', source: 'history', lastUsedAt: 1000 },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session starts a session for a path in the known/allowed set and returns its id and status', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectDir = join(tempDir, 'allowed-project');
    await mkdir(projectDir);
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });
      // start_session re-validates against the same known set list_projects reports (never trusts
      // a phone's earlier list call) — so "a path in the known/allowed set" means it must already
      // be in history (or under projectsRoot). The brief's own reference test omitted this setup
      // step, which made the call fail validation before ever reaching SessionManager.
      await recordProjectUsed(projectDir, { filePath, now: () => 1000 });

      const outcome = await dispatchRpc('start_session', { projectPath: projectDir, prompt: 'hello' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.error).toBeUndefined();
      const result = outcome.result as { id: string; status: string };
      expect(typeof result.id).toBe('string');
      expect(result.status).toBe('running');
    } finally {
      // start_session triggers SessionManager.startSession's fire-and-forget recordProjectUsed
      // write (deliberately un-awaited in production code) — wait for it to settle before
      // removing tempDir, or the write's mkdir/writeFile can recreate part of the directory after
      // rm's walk has already passed it, causing an intermittent ENOTEMPTY.
      await whenProjectStoreIdle();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session rejects a path that is not known and not under projectsRoot with INVALID_PROJECT_PATH', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('start_session', { projectPath: '/tmp/never-seen-this-path', prompt: 'hello' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toBe(RPC_ERROR_CODES.INVALID_PROJECT_PATH);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session rejects with CONCURRENT_SESSION_LIMIT once the daemon is at its cap', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectDir = join(tempDir, 'allowed-project');
    await mkdir(projectDir);
    try {
      const manager = new SessionManager({
        queryFn: createMockQueryFn(),
        getSessionMessagesFn: async () => [],
        onEvent: () => {},
        projectStoreFilePath: filePath,
        maxConcurrentSessions: 1,
      });
      // Registered explicitly (awaited) rather than relying on manager.startSession's own
      // fire-and-forget recordProjectUsed side effect, which races with resolveKnownProjects'
      // read inside the RPC call below and made this test flaky/order-dependent as given in the
      // brief.
      await recordProjectUsed(projectDir, { filePath, now: () => 1000 });
      manager.startSession(projectDir, 'first');

      const outcome = await dispatchRpc('start_session', { projectPath: projectDir, prompt: 'second' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toBe(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT);
    } finally {
      // The first (successful) manager.startSession('first') call above also has a fire-and-forget
      // recordProjectUsed write in flight — wait for it before removing tempDir (see comment on
      // the earlier finally block for why).
      await whenProjectStoreIdle();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // --- Correction 1: a genuine runner-start failure must NOT be mislabeled as the concurrent
  // session cap. SessionManager.startSession has two distinct throw paths — a marked
  // `isCapExceeded` throw, and a bare Error from a failed runner.start() (bad cwd, SDK error,
  // etc.). The handler must check the marker specifically, not blanket-map every throw to
  // CONCURRENT_SESSION_LIMIT.
  it('start_session does NOT report CONCURRENT_SESSION_LIMIT for a genuine (non-cap) runner-start failure — falls through to HANDLER_ERROR', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    const projectDir = join(tempDir, 'allowed-project');
    await mkdir(projectDir);
    try {
      // Well under any concurrency cap, so the only way startSession can throw here is the
      // runner-start failure path, not the cap-exceeded path.
      const manager = new SessionManager({
        queryFn: createThrowingQueryFn(),
        getSessionMessagesFn: async () => [],
        onEvent: () => {},
        projectStoreFilePath: filePath,
        maxConcurrentSessions: 3,
      });
      await recordProjectUsed(projectDir, { filePath, now: () => 1000 });

      const outcome = await dispatchRpc('start_session', { projectPath: projectDir, prompt: 'hello' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.result).toBeUndefined();
      expect(outcome.error).toBe(RPC_ERROR_CODES.HANDLER_ERROR);
      expect(outcome.error).not.toBe(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT);
    } finally {
      // Defensive, same as the other start_session tests above: wait for any pending
      // recordProjectUsed write before removing tempDir.
      await whenProjectStoreIdle();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // --- Correction 2: a malformed start_session call must produce a clean typed `error`, not a
  // `result` object with an `error` key nested inside it (the wire-protocol bug the brief's
  // literal reference code would have produced by `return`ing instead of `throw`ing).
  it('start_session rejects malformed params (missing prompt) with a clean INVALID_PROJECT_PATH error, not a result containing an error key', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('start_session', { projectPath: '/some/path' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.error).toBe(RPC_ERROR_CODES.INVALID_PROJECT_PATH);
      expect(outcome.result).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('start_session rejects malformed params (projectPath not a string) with a clean INVALID_PROJECT_PATH error, not a result containing an error key', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'companion-rpc-projects-test-'));
    const filePath = join(tempDir, 'daemon-projects.json');
    try {
      const manager = new SessionManager({ queryFn: createMockQueryFn(), getSessionMessagesFn: async () => [], onEvent: () => {}, projectStoreFilePath: filePath });

      const outcome = await dispatchRpc('start_session', { projectPath: 42, prompt: 'hello' }, {
        version: '0.1.0',
        startedAt: 0,
        manager,
        projectStoreFilePath: filePath,
        projectsRoot: undefined,
      });

      expect(outcome.error).toBe(RPC_ERROR_CODES.INVALID_PROJECT_PATH);
      expect(outcome.result).toBeUndefined();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
