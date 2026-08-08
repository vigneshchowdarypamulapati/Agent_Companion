import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from './session-manager.js';
import { dispatchCommand } from './command-dispatcher.js';
import { AsyncQueue } from './async-queue.js';
import type {
  AgentMessage,
  AgentQuery,
  PermissionRequest,
  PermissionResponse,
  QueryFn,
} from './agent-sdk-port.js';

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
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, onEvent: () => {} });
    await expect(
      dispatchCommand(manager, { type: 'start_session', projectPath: '/tmp/project', prompt: 'hi' })
    ).rejects.toThrow('start_session must be issued locally');
  });

  it('dispatches inject_prompt, respond_to_permission, pause, resume, and stop to the right session', async () => {
    const agent = createMockAgent();
    const manager = new SessionManager({ queryFn: agent.queryFn, onEvent: () => {} });
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
    const manager = new SessionManager({ queryFn: createMockAgent().queryFn, onEvent: () => {} });
    await expect(
      dispatchCommand(manager, { type: 'pause', sessionId: 'does-not-exist' })
    ).rejects.toThrow('No session with id does-not-exist');
  });
});
