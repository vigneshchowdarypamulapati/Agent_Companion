import { describe, it, expect, vi, afterAll } from 'vitest';
import { SessionManager } from './session-manager.js';
import { dispatchCommand, dispatchCommandWithAck } from './command-dispatcher.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SessionManager now requires a projectStoreFilePath. Tests here don't care about project-history
// persistence, only that command dispatch is wired up correctly, so every test gets its own file
// inside one shared temp directory (avoids per-test mkdtemp/cleanup ceremony) that's removed once
// after the whole suite finishes — same pattern as http-server.test.ts.
const sharedTempDir = mkdtempSync(join(tmpdir(), 'companion-command-dispatcher-test-'));
afterAll(() => rm(sharedTempDir, { recursive: true, force: true }));

function newProjectStoreFilePath(): string {
  return join(sharedTempDir, `daemon-projects-${randomUUID()}.json`);
}

function createMockAgent() {
  const outgoing = new AsyncQueue<AgentMessage>();
  let canUseTool: ((request: PermissionRequest) => Promise<PermissionResponse>) | undefined;
  const queryFn: QueryFn = ({ options }) => {
    canUseTool = options.canUseTool;
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => outgoing.close()),
    };
    return agentQuery;
  };
  return { queryFn, outgoing, getCanUseTool: () => canUseTool! };
}

describe('dispatchCommand', () => {
  it('rejects start_session', async () => {
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, getSessionMessagesFn: vi.fn(async () => []), onEvent: () => {}, projectStoreFilePath: newProjectStoreFilePath() });
    await expect(
      dispatchCommand(manager, { type: 'start_session', projectPath: '/tmp/project', prompt: 'hi' })
    ).rejects.toThrow('start_session must be issued locally');
  });

  it('dispatches inject_prompt, respond_to_permission, pause, resume, and stop to the right session', async () => {
    const agent = createMockAgent();
    const manager = new SessionManager({ queryFn: agent.queryFn, getSessionMessagesFn: vi.fn(async () => []), onEvent: () => {}, projectStoreFilePath: newProjectStoreFilePath() });
    const runner = manager.startSession('/tmp/project', 'do the thing');

    const permissionPromise = agent.getCanUseTool()({ requestId: 'req-1', toolName: 'Bash', input: {} });
    await new Promise((resolve) => setImmediate(resolve));
    await dispatchCommand(manager, {
      type: 'respond_to_permission',
      sessionId: runner.id,
      requestId: 'req-1',
      approved: true,
    });
    await expect(permissionPromise).resolves.toEqual({ approved: true });

    await dispatchCommand(manager, { type: 'pause', sessionId: runner.id });
    expect(runner.status).toBe('paused');

    await dispatchCommand(manager, { type: 'resume', sessionId: runner.id });
    expect(runner.status).toBe('running');

    await expect(
      dispatchCommand(manager, { type: 'inject_prompt', sessionId: runner.id, text: 'follow up' })
    ).resolves.toBeUndefined();

    await dispatchCommand(manager, { type: 'stop', sessionId: runner.id });
    expect(runner.status).toBe('stopped');
  });

  it('propagates the error for an unknown session id', async () => {
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, getSessionMessagesFn: vi.fn(async () => []), onEvent: () => {}, projectStoreFilePath: newProjectStoreFilePath() });
    await expect(
      dispatchCommand(manager, { type: 'pause', sessionId: 'does-not-exist' })
    ).rejects.toThrow('No session with id does-not-exist');
  });
});

describe('dispatchCommandWithAck', () => {
  it("acks 'delivered' and returns ok when dispatch succeeds", async () => {
    const agent = createMockAgent();
    const manager = new SessionManager({ queryFn: agent.queryFn, getSessionMessagesFn: vi.fn(async () => []), onEvent: () => {}, projectStoreFilePath: newProjectStoreFilePath() });
    const runner = manager.startSession('/tmp/project', 'do the thing');
    const acks: { status: 'delivered' | 'failed'; message?: string }[] = [];

    const result = await dispatchCommandWithAck(manager, { type: 'pause', sessionId: runner.id }, (status, message) =>
      acks.push({ status, message })
    );

    expect(result).toEqual({ ok: true });
    expect(acks).toEqual([{ status: 'delivered', message: undefined }]);
    expect(runner.status).toBe('paused');
  });

  it("acks 'failed' with the thrown message and returns ok:false when dispatch throws, without touching the session", async () => {
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, getSessionMessagesFn: vi.fn(async () => []), onEvent: () => {}, projectStoreFilePath: newProjectStoreFilePath() });
    const acks: { status: 'delivered' | 'failed'; message?: string }[] = [];

    const result = await dispatchCommandWithAck(
      manager,
      { type: 'pause', sessionId: 'does-not-exist' },
      (status, message) => acks.push({ status, message })
    );

    expect(result).toEqual({ ok: false, message: 'No session with id does-not-exist' });
    expect(acks).toEqual([{ status: 'failed', message: 'No session with id does-not-exist' }]);
  });

  it('calls sendAck exactly once per dispatch, whether it succeeds or fails', async () => {
    const agent = createMockAgent();
    const manager = new SessionManager({ queryFn: agent.queryFn, getSessionMessagesFn: vi.fn(async () => []), onEvent: () => {}, projectStoreFilePath: newProjectStoreFilePath() });
    const runner = manager.startSession('/tmp/project', 'do the thing');
    const sendAck = vi.fn();

    await dispatchCommandWithAck(manager, { type: 'pause', sessionId: runner.id }, sendAck);
    expect(sendAck).toHaveBeenCalledTimes(1);

    sendAck.mockClear();
    await dispatchCommandWithAck(manager, { type: 'pause', sessionId: 'does-not-exist' }, sendAck);
    expect(sendAck).toHaveBeenCalledTimes(1);
  });
});
