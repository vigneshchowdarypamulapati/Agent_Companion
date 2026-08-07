import { describe, it, expect, vi } from 'vitest';
import { SessionRunner } from './session-runner.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';
import type { SessionEvent } from '@companion/protocol';

function createMockAgent() {
  const outgoing = new AsyncQueue<AgentMessage>();
  const interrupt = vi.fn(async () => {});
  const close = vi.fn(() => outgoing.close());
  let capturedCanUseTool:
    | ((request: PermissionRequest) => Promise<PermissionResponse>)
    | undefined;
  let capturedPrompt: AsyncIterable<{ type: 'user'; text: string }> | undefined;

  const queryFn: QueryFn = ({ prompt, options }) => {
    capturedPrompt = prompt;
    capturedCanUseTool = options.canUseTool;
    const agentQuery: AgentQuery = {
      [Symbol.asyncIterator]: () => outgoing[Symbol.asyncIterator](),
      interrupt,
      close,
    };
    return agentQuery;
  };

  return {
    queryFn,
    outgoing,
    interrupt,
    close,
    getCanUseTool: () => capturedCanUseTool!,
    getPrompt: () => capturedPrompt!,
  };
}

describe('SessionRunner', () => {
  it('emits session_started and assistant_text events as the agent streams messages', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    agent.outgoing.push({ type: 'assistant_text', text: 'Working on it' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events[0]).toMatchObject({ type: 'session_started', sessionId: 'session-1' });
    expect(events[1]).toMatchObject({ type: 'assistant_text', text: 'Working on it' });
  });

  it('emits a permission_request and blocks until respondToPermission resolves it', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-2',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the risky thing');
    await new Promise((resolve) => setImmediate(resolve));

    const canUseTool = agent.getCanUseTool();
    let responded = false;
    const responsePromise = canUseTool({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    }).then((r) => {
      responded = true;
      return r;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.status).toBe('waiting_permission');
    expect(events.some((e) => e.type === 'permission_request')).toBe(true);
    expect(responded).toBe(false);

    runner.respondToPermission('req-1', { approved: true });
    const response = await responsePromise;

    expect(response).toEqual({ approved: true });
    expect(runner.status).toBe('running');
    expect(events.some((e) => e.type === 'permission_resolved')).toBe(true);
  });

  it('pause calls interrupt on the underlying agent query and sets status paused', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-3',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.pause();

    expect(agent.interrupt).toHaveBeenCalledTimes(1);
    expect(runner.status).toBe('paused');
  });

  it('resume sets status back to running, and injectPrompt pushes onto the input stream', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-4',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.pause();
    runner.resume();
    expect(runner.status).toBe('running');

    runner.injectPrompt('follow up prompt');
    const prompt = agent.getPrompt();
    const iterator = prompt[Symbol.asyncIterator]();
    await iterator.next(); // consumes 'do the thing'
    const second = await iterator.next();
    expect(second.value).toEqual({ type: 'user', text: 'follow up prompt' });
  });

  it('stop closes the input queue and the agent query, and emits a stopped event', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-5',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await runner.stop();

    expect(agent.close).toHaveBeenCalledTimes(1);
    expect(runner.status).toBe('stopped');
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
  });

  it('emits an error event and marks the session stopped if the agent stream throws', async () => {
    const queryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('agent crashed')),
      }),
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-6',
      projectPath: '/tmp/project',
      queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      events.some((e) => e.type === 'error' && e.message === 'agent crashed')
    ).toBe(true);
    expect(runner.status).toBe('stopped');
  });

  it('rejects injecting a prompt into a stopped session', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-7',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.stop();

    expect(() => runner.injectPrompt('too late')).toThrow();
  });

  it('stop() while a permission is pending resolves the permission with approved: false', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-8',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the risky thing');
    await new Promise((resolve) => setImmediate(resolve));

    const canUseTool = agent.getCanUseTool();
    let permissionResolved = false;
    let resolvedResponse: PermissionResponse | undefined;
    const permissionPromise = canUseTool({
      requestId: 'req-pending',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    }).then((r) => {
      permissionResolved = true;
      resolvedResponse = r;
      return r;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.status).toBe('waiting_permission');
    expect(permissionResolved).toBe(false);

    // Stop the session while permission is pending
    await runner.stop();
    await permissionPromise;

    expect(permissionResolved).toBe(true);
    expect(resolvedResponse).toEqual({ approved: false, reason: 'session stopped' });
    expect(runner.status).toBe('stopped');
  });

  it('respondToPermission called after stop() does not resurrect status', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-9',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the risky thing');
    await new Promise((resolve) => setImmediate(resolve));

    const canUseTool = agent.getCanUseTool();
    let permissionResolved = false;
    const permissionPromise = canUseTool({
      requestId: 'req-late',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    }).then(() => {
      permissionResolved = true;
    });

    await new Promise((resolve) => setImmediate(resolve));
    await runner.stop();
    await permissionPromise;

    // Try to respond to the permission after stop() has been called
    // This should be a no-op or throw, but status must remain 'stopped'
    expect(() => runner.respondToPermission('req-late', { approved: true })).toThrow();
    expect(runner.status).toBe('stopped');
  });

  it('pause() on a stopped session throws', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-10',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.stop();

    expect(runner.status).toBe('stopped');
    await expect(runner.pause()).rejects.toThrow(/Cannot pause stopped session/);
  });

  it('agent stream completing normally emits stopped event and sets status to stopped', async () => {
    const queryFn: QueryFn = () => ({
      [Symbol.asyncIterator]: async function* () {
        // Simulate graceful stream completion (no error, just ends)
        yield { type: 'assistant_text', text: 'Done!' };
        // Stream ends here without throwing
      },
      interrupt: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    });
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-11',
      projectPath: '/tmp/project',
      queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await new Promise((resolve) => setImmediate(resolve));

    // Wait a bit for drainMessages to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(runner.status).toBe('stopped');
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    // No error event should be emitted
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('stop() called twice is idempotent', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-12',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await runner.stop();

    const stoppedEventsAfterFirstStop = events.filter((e) => e.type === 'stopped').length;

    // Call stop() again
    await runner.stop();

    const stoppedEventsAfterSecondStop = events.filter((e) => e.type === 'stopped').length;

    // Should still have only one stopped event
    expect(stoppedEventsAfterFirstStop).toBe(1);
    expect(stoppedEventsAfterSecondStop).toBe(1);
    expect(agent.close).toHaveBeenCalledTimes(1);
  });
});
