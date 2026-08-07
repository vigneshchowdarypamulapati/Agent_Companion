import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { SessionManager } from './session-manager.js';
import { createHttpServer } from './http-server.js';
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

describe('HTTP control surface', () => {
  it('drives a full session lifecycle: start, permission, pause, resume, prompt, stop', async () => {
    const agent = createMockAgent();
    const eventLog: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: agent.queryFn,
      onEvent: (e) => eventLog.push(e),
    });
    const app = createHttpServer(manager, eventLog);

    const startRes = await request(app)
      .post('/sessions')
      .send({ projectPath: '/tmp/project', prompt: 'do the thing' });
    expect(startRes.status).toBe(201);
    const sessionId = startRes.body.id as string;

    agent.outgoing.push({ type: 'assistant_text', text: 'On it' });
    await new Promise((resolve) => setImmediate(resolve));

    const eventsRes = await request(app).get(`/sessions/${sessionId}/events`);
    expect(
      eventsRes.body.some((e: SessionEvent) => e.type === 'assistant_text')
    ).toBe(true);

    const canUseTool = agent.getCanUseTool();
    const permissionPromise = canUseTool({ requestId: 'req-1', toolName: 'Bash', input: {} });
    await new Promise((resolve) => setImmediate(resolve));

    const respondRes = await request(app)
      .post(`/sessions/${sessionId}/respond`)
      .send({ requestId: 'req-1', approved: true });
    expect(respondRes.status).toBe(204);
    await expect(permissionPromise).resolves.toEqual({ approved: true });

    const pauseRes = await request(app).post(`/sessions/${sessionId}/pause`);
    expect(pauseRes.status).toBe(204);

    const resumeRes = await request(app).post(`/sessions/${sessionId}/resume`);
    expect(resumeRes.status).toBe(204);

    const promptRes = await request(app)
      .post(`/sessions/${sessionId}/prompt`)
      .send({ text: 'follow up' });
    expect(promptRes.status).toBe(204);

    const stopRes = await request(app).post(`/sessions/${sessionId}/stop`);
    expect(stopRes.status).toBe(204);

    const finalEvents = await request(app).get(`/sessions/${sessionId}/events`);
    expect(finalEvents.body.some((e: SessionEvent) => e.type === 'stopped')).toBe(true);
  });

  it('returns 400 when starting a second session while one is active', async () => {
    const agent = createMockAgent();
    const eventLog: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: agent.queryFn,
      onEvent: (e) => eventLog.push(e),
    });
    const app = createHttpServer(manager, eventLog);

    await request(app).post('/sessions').send({ projectPath: '/tmp/project', prompt: 'first' });
    const secondRes = await request(app)
      .post('/sessions')
      .send({ projectPath: '/tmp/project', prompt: 'second' });

    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toContain('Cannot start a new session');
  });

  it('returns 400 for commands against an unknown session id', async () => {
    const agent = createMockAgent();
    const eventLog: SessionEvent[] = [];
    const manager = new SessionManager({
      queryFn: agent.queryFn,
      onEvent: (e) => eventLog.push(e),
    });
    const app = createHttpServer(manager, eventLog);

    const res = await request(app).post('/sessions/does-not-exist/pause');
    expect(res.status).toBe(400);
  });
});
