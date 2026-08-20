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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.pause();

    expect(agent.interrupt).toHaveBeenCalledTimes(1);
    expect(runner.status).toBe('paused');
  });

  it('emits turn_complete when the agent stream reports it and the session is not paused', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-15',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    agent.outgoing.push({ type: 'turn_complete' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.some((e) => e.type === 'turn_complete')).toBe(true);
  });

  it('suppresses turn_complete when it arrives as the delayed result of a pause-induced interrupt', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-16',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: (e) => events.push(e),
    });

    runner.start('do the thing');
    await runner.pause();

    // Simulate the interrupted turn's result message arriving on the main stream
    // after interrupt() has already resolved and paused() has set status to 'paused'.
    agent.outgoing.push({ type: 'turn_complete' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(runner.status).toBe('paused');
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);
  });

  it('resume sets status back to running, and injectPrompt pushes onto the input stream', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-4',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
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
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: () => {},
    });

    runner.start('do the thing');
    await runner.stop();

    expect(runner.status).toBe('stopped');
    await expect(runner.pause()).rejects.toThrow(/Cannot pause stopped session/);
  });

  it('pause() on a session waiting for permission throws', async () => {
    const agent = createMockAgent();
    const runner = new SessionRunner({
      id: 'session-13',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: () => {},
    });

    runner.start('do the risky thing');
    await new Promise((resolve) => setImmediate(resolve));

    const canUseTool = agent.getCanUseTool();
    // Start a permission request (this sets status to waiting_permission)
    const permissionPromise = canUseTool({
      requestId: 'req-waiting',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.status).toBe('waiting_permission');

    // Attempting to pause while waiting for permission should throw
    await expect(runner.pause()).rejects.toThrow(
      /Cannot pause session.*while waiting for permission/
    );

    // Status should still be waiting_permission
    expect(runner.status).toBe('waiting_permission');

    // Clean up: respond to the permission so the promise doesn't hang
    runner.respondToPermission('req-waiting', { approved: false });
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
      getSessionMessagesFn: vi.fn(async () => []),
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

  it('crash while a permission is pending resolves the permission instead of hanging, closes the agent query, and emits both error and stopped', async () => {
    const close = vi.fn(() => {});
    let capturedCanUseTool:
      | ((request: PermissionRequest) => Promise<PermissionResponse>)
      | undefined;
    let releaseCrash: () => void;
    const crashGate = new Promise<void>((resolve) => {
      releaseCrash = resolve;
    });
    const queryFn: QueryFn = ({ options }) => {
      capturedCanUseTool = options.canUseTool;
      const agentQuery: AgentQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            // Block until the test says go, so a permission request can be
            // registered before the stream crashes.
            await crashGate;
            throw new Error('agent crashed mid-permission');
          },
        }),
        interrupt: vi.fn(async () => {}),
        close,
      };
      return agentQuery;
    };
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-14',
      projectPath: '/tmp/project',
      queryFn,
      getSessionMessagesFn: vi.fn(async () => []),
      onEvent: (e) => events.push(e),
    });

    runner.start('do the risky thing');
    await new Promise((resolve) => setImmediate(resolve));

    const permissionPromise = capturedCanUseTool!({
      requestId: 'req-crash',
      toolName: 'Bash',
      input: {},
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(runner.status).toBe('waiting_permission');

    releaseCrash!();

    const response = await permissionPromise;
    expect(response).toEqual({ approved: false, reason: 'session crashed' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'stopped')).toBe(true);
    expect(runner.status).toBe('stopped');
  });

  it('stop() called twice is idempotent', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const runner = new SessionRunner({
      id: 'session-12',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn: vi.fn(async () => []),
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

function createMockGetSessionMessagesFn(messages: { role: 'user' | 'assistant'; text: string }[]) {
  return vi.fn(async () => messages);
}

describe('SessionRunner.adopt', () => {
  it('emits session_started with no prompt pushed to the input queue', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const getSessionMessagesFn = createMockGetSessionMessagesFn([]);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(events[0]).toMatchObject({
      type: 'session_started',
      sessionId: 'session-new-1',
      projectPath: '/tmp/project',
    });
    // If adopt() had pushed an initial prompt the way start() does, it would be the first item
    // this iterator yields. Push a sentinel now via the runner's own public injectPrompt() and
    // confirm the sentinel — not some earlier prompt — is what comes out first, proving the
    // queue was genuinely empty when adopt() ran (not just asserting on a runtime race).
    runner.injectPrompt('sentinel');
    const iterator = agent.getPrompt()[Symbol.asyncIterator]();
    const { value } = await iterator.next();
    expect(value).toEqual({ type: 'user', text: 'sentinel' });
  });

  it('passes sessionId and resumeSessionId through to queryFn', async () => {
    const agent = createMockAgent();
    const getSessionMessagesFn = createMockGetSessionMessagesFn([]);
    let capturedOptions: { sessionId?: string; resumeSessionId?: string } = {};
    const capturingQueryFn: QueryFn = (args) => {
      capturedOptions = args.options;
      return agent.queryFn(args);
    };
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: capturingQueryFn,
      getSessionMessagesFn,
      onEvent: () => {},
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(capturedOptions.sessionId).toBe('session-new-1');
    expect(capturedOptions.resumeSessionId).toBe('original-session-1');
  });

  it('fetches history and emits one adopted_history event after session_started', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const getSessionMessagesFn = createMockGetSessionMessagesFn([
      { role: 'user', text: 'fix the bug in auth.ts' },
      { role: 'assistant', text: 'Found it — the token check was inverted.' },
    ]);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(getSessionMessagesFn).toHaveBeenCalledWith('original-session-1', { dir: '/tmp/project' });
    expect(events[1]).toMatchObject({
      type: 'adopted_history',
      sessionId: 'session-new-1',
      originalSessionId: 'original-session-1',
      messages: [
        { role: 'user', text: 'fix the bug in auth.ts' },
        { role: 'assistant', text: 'Found it — the token check was inverted.' },
      ],
      truncated: false,
    });
  });

  it('caps history to the most recent 50 messages and sets truncated: true', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const allMessages = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `message ${i}`,
    }));
    const getSessionMessagesFn = createMockGetSessionMessagesFn(allMessages);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));

    const historyEvent = events.find((e) => e.type === 'adopted_history');
    expect(historyEvent).toMatchObject({ truncated: true });
    expect((historyEvent as { messages: unknown[] }).messages).toHaveLength(50);
    expect((historyEvent as { messages: { text: string }[] }).messages[0].text).toBe('message 10');
    expect((historyEvent as { messages: { text: string }[] }).messages[49].text).toBe('message 59');
  });

  it('still processes assistant_text and other live events normally after adopting', async () => {
    const agent = createMockAgent();
    const events: SessionEvent[] = [];
    const getSessionMessagesFn = createMockGetSessionMessagesFn([]);
    const runner = new SessionRunner({
      id: 'session-new-1',
      projectPath: '/tmp/project',
      queryFn: agent.queryFn,
      getSessionMessagesFn,
      onEvent: (e) => events.push(e),
    });

    runner.adopt('original-session-1');
    await new Promise((resolve) => setImmediate(resolve));
    agent.outgoing.push({ type: 'assistant_text', text: 'How can I help?' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.some((e) => e.type === 'assistant_text' && e.text === 'How can I help?')).toBe(true);
  });
});
