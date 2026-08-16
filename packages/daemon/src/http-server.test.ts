import { describe, it, expect, vi } from 'vitest';
import request, { type Test } from 'supertest';
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

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef01';

/** Attaches the bearer token every route requires. */
function auth(req: Test): Test {
  return req.set('Authorization', `Bearer ${TOKEN}`);
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

function setUp() {
  const agent = createMockAgent();
  const eventLog: SessionEvent[] = [];
  const manager = new SessionManager({
    queryFn: agent.queryFn,
    onEvent: (e) => eventLog.push(e),
  });
  const app = createHttpServer(manager, eventLog, { token: TOKEN });
  return { agent, eventLog, manager, app };
}

describe('HTTP control surface', () => {
  it('drives a full session lifecycle: start, permission, pause, resume, prompt, stop', async () => {
    const { agent, app } = setUp();

    const startRes = await auth(request(app).post('/sessions')).send({
      projectPath: '/tmp/project',
      prompt: 'do the thing',
    });
    expect(startRes.status).toBe(201);
    const sessionId = startRes.body.id as string;

    agent.outgoing.push({ type: 'assistant_text', text: 'On it' });
    await new Promise((resolve) => setImmediate(resolve));

    const eventsRes = await auth(request(app).get(`/sessions/${sessionId}/events`));
    expect(
      eventsRes.body.some((e: SessionEvent) => e.type === 'assistant_text')
    ).toBe(true);

    const canUseTool = agent.getCanUseTool();
    const permissionPromise = canUseTool({ requestId: 'req-1', toolName: 'Bash', input: {} });
    await new Promise((resolve) => setImmediate(resolve));

    const respondRes = await auth(request(app).post(`/sessions/${sessionId}/respond`)).send({
      requestId: 'req-1',
      approved: true,
    });
    expect(respondRes.status).toBe(204);
    await expect(permissionPromise).resolves.toEqual({ approved: true });

    const pauseRes = await auth(request(app).post(`/sessions/${sessionId}/pause`));
    expect(pauseRes.status).toBe(204);

    const resumeRes = await auth(request(app).post(`/sessions/${sessionId}/resume`));
    expect(resumeRes.status).toBe(204);

    const promptRes = await auth(request(app).post(`/sessions/${sessionId}/prompt`)).send({
      text: 'follow up',
    });
    expect(promptRes.status).toBe(204);

    const stopRes = await auth(request(app).post(`/sessions/${sessionId}/stop`));
    expect(stopRes.status).toBe(204);

    const finalEvents = await auth(request(app).get(`/sessions/${sessionId}/events`));
    expect(finalEvents.body.some((e: SessionEvent) => e.type === 'stopped')).toBe(true);
  });

  it('returns 400 when starting a second session while one is active', async () => {
    const { app } = setUp();

    await auth(request(app).post('/sessions')).send({ projectPath: '/tmp/project', prompt: 'first' });
    const secondRes = await auth(request(app).post('/sessions')).send({
      projectPath: '/tmp/project',
      prompt: 'second',
    });

    expect(secondRes.status).toBe(400);
    expect(secondRes.body.error).toContain('Cannot start a new session');
  });

  it('returns 400 for commands against an unknown session id', async () => {
    const { app } = setUp();

    const res = await auth(request(app).post('/sessions/does-not-exist/pause'));
    expect(res.status).toBe(400);
  });

  it('returns 400 (not 201) when POST /sessions is sent an empty body', async () => {
    const { manager, app } = setUp();

    const res = await auth(request(app).post('/sessions')).send({});

    expect(res.status).toBe(400);
    expect(manager.getActiveSession()).toBeUndefined();
  });

  it('returns 400 when POST /sessions/:id/respond is missing the approved field', async () => {
    const { app } = setUp();

    const startRes = await auth(request(app).post('/sessions')).send({
      projectPath: '/tmp/project',
      prompt: 'do the thing',
    });
    const sessionId = startRes.body.id as string;

    const res = await auth(request(app).post(`/sessions/${sessionId}/respond`)).send({ requestId: 'req-1' });

    expect(res.status).toBe(400);
  });
});

describe('local HTTP surface auth', () => {
  it('returns 401 and never reaches SessionManager when no Authorization header is sent', async () => {
    const { manager, app } = setUp();

    const res = await request(app).post('/sessions').send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
    expect(manager.getActiveSession()).toBeUndefined();
  });

  it('returns 401 for a well-formed but wrong bearer token', async () => {
    const { manager, app } = setUp();

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', 'Bearer wrong-token-entirely')
      .send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
    expect(manager.getActiveSession()).toBeUndefined();
  });

  it('returns 401 for a malformed Authorization header (no Bearer prefix)', async () => {
    const { app } = setUp();

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', TOKEN)
      .send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
  });

  it('returns 403 for a correct token but a spoofed Host header (DNS-rebinding shape)', async () => {
    const { manager, app } = setUp();

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Host', 'attacker.example.com')
      .send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(403);
    expect(manager.getActiveSession()).toBeUndefined();
  });

  it('succeeds with the correct token and the default loopback Host supertest sends', async () => {
    const { app } = setUp();

    const res = await auth(request(app).post('/sessions')).send({
      projectPath: '/tmp/project',
      prompt: 'x',
    });

    expect(res.status).toBe(201);
  });
});
