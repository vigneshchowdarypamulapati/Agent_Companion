import { describe, it, expect, vi, afterAll } from 'vitest';
import request, { type Test } from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
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
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef01';

// SessionManager now requires a projectStoreFilePath. Tests here don't care about project-history
// persistence, only that startSession is wired up correctly, so every test gets its own file
// inside one shared temp directory (avoids per-test mkdtemp/cleanup ceremony) that's removed once
// after the whole suite finishes.
const sharedTempDir = mkdtempSync(join(tmpdir(), 'companion-http-server-test-'));
afterAll(() => rm(sharedTempDir, { recursive: true, force: true }));

/** Attaches the bearer token every route requires. */
function auth(req: Test): Test {
  return req.set('Authorization', `Bearer ${TOKEN}`);
}

/**
 * Host-allowlist checks compare against the port the request actually
 * arrived on (`req.socket.localPort`), so testing `localhost:<port>` or
 * `[::1]:<port>` needs a real, known port rather than supertest's usual
 * throwaway ephemeral binding per call. This binds the app to an
 * OS-assigned port, hands the caller both the live `server` (so supertest
 * targets that exact listener) and its `port` (to build a matching Host
 * header), and always closes it afterward.
 */
async function withListeningServer(
  app: Express,
  fn: (server: Server, port: number) => Promise<void>
): Promise<void> {
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(server, port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

function setUp(overrides: { maxConcurrentSessions?: number } = {}) {
  const agent = createMockAgent();
  const eventLog: SessionEvent[] = [];
  const projectStoreFilePath = join(sharedTempDir, `daemon-projects-${randomUUID()}.json`);
  const manager = new SessionManager({
    queryFn: agent.queryFn,
    getSessionMessagesFn: vi.fn(async () => []),
    onEvent: (e) => eventLog.push(e),
    projectStoreFilePath,
    ...overrides,
  });
  // Spied so tests can assert "SessionManager was never reached" directly, now that
  // SessionManager no longer exposes an active-session accessor to infer that from.
  const startSessionSpy = vi.spyOn(manager, 'startSession');
  const app = createHttpServer(manager, eventLog, { token: TOKEN });
  return { agent, eventLog, manager, app, startSessionSpy };
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
    const { app } = setUp({ maxConcurrentSessions: 1 });

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
    const { startSessionSpy, app } = setUp();

    const res = await auth(request(app).post('/sessions')).send({});

    expect(res.status).toBe(400);
    expect(startSessionSpy).not.toHaveBeenCalled();
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
    const { startSessionSpy, app } = setUp();

    const res = await request(app).post('/sessions').send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
    expect(startSessionSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for a well-formed but wrong bearer token', async () => {
    const { startSessionSpy, app } = setUp();

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', 'Bearer wrong-token-entirely')
      .send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
    expect(startSessionSpy).not.toHaveBeenCalled();
  });

  it('returns 401 for a malformed Authorization header (no Bearer prefix)', async () => {
    const { app } = setUp();

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', TOKEN)
      .send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
  });

  it('sends WWW-Authenticate: Bearer on a 401', async () => {
    const { app } = setUp();

    const res = await request(app).post('/sessions').send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('accepts the Bearer scheme case-insensitively, per RFC 7235', async () => {
    const { app } = setUp();

    const lower = await request(app)
      .post('/sessions')
      .set('Authorization', `bearer ${TOKEN}`)
      .send({ projectPath: '/tmp/project', prompt: 'x' });
    expect(lower.status).toBe(201);

    const upper = await request(app)
      .post('/sessions/does-not-exist/pause')
      .set('Authorization', `BEARER ${TOKEN}`);
    // Any non-401/403 proves auth passed and the request reached the route.
    expect(upper.status).toBe(400);
  });

  it('returns 403 for a correct token but a spoofed Host header (DNS-rebinding shape)', async () => {
    const { startSessionSpy, app } = setUp();

    const res = await request(app)
      .post('/sessions')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Host', 'attacker.example.com')
      .send({ projectPath: '/tmp/project', prompt: 'x' });

    expect(res.status).toBe(403);
    expect(startSessionSpy).not.toHaveBeenCalled();
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

describe('Host allowlist', () => {
  // supertest's default request always uses "127.0.0.1:<ephemeral-port>",
  // which the "succeeds with the correct token..." case above already
  // covers. That leaves the other two allowed forms — and any near-miss —
  // completely untested, which matters precisely because this is the layer
  // that actually defeats DNS rebinding: a refactor to, say, parsed/regex
  // Host matching could silently loosen it (e.g. accept "localhost.evil.com"
  // as a prefix match) with every existing test still green.

  it('allows "localhost:<port>"', async () => {
    const { app } = setUp();
    await withListeningServer(app, async (server, port) => {
      const res = await request(server)
        .post('/sessions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Host', `localhost:${port}`)
        .send({ projectPath: '/tmp/project', prompt: 'x' });

      expect(res.status).toBe(201);
    });
  });

  it('allows "[::1]:<port>"', async () => {
    const { app } = setUp();
    await withListeningServer(app, async (server, port) => {
      const res = await request(server)
        .post('/sessions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Host', `[::1]:${port}`)
        .send({ projectPath: '/tmp/project', prompt: 'x' });

      expect(res.status).toBe(201);
    });
  });

  it('rejects a case-different Host ("LOCALHOST:<port>")', async () => {
    const { app } = setUp();
    await withListeningServer(app, async (server, port) => {
      const res = await request(server)
        .post('/sessions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Host', `LOCALHOST:${port}`)
        .send({ projectPath: '/tmp/project', prompt: 'x' });

      expect(res.status).toBe(403);
    });
  });

  it('rejects a Host with a trailing dot ("localhost.:<port>")', async () => {
    const { app } = setUp();
    await withListeningServer(app, async (server, port) => {
      const res = await request(server)
        .post('/sessions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Host', `localhost.:${port}`)
        .send({ projectPath: '/tmp/project', prompt: 'x' });

      expect(res.status).toBe(403);
    });
  });

  it('rejects a Host with no port ("localhost")', async () => {
    const { app } = setUp();
    await withListeningServer(app, async (server) => {
      const res = await request(server)
        .post('/sessions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Host', 'localhost')
        .send({ projectPath: '/tmp/project', prompt: 'x' });

      expect(res.status).toBe(403);
    });
  });

  it('rejects an attacker-controlled hostname even on the right port', async () => {
    const { app } = setUp();
    await withListeningServer(app, async (server, port) => {
      const res = await request(server)
        .post('/sessions')
        .set('Authorization', `Bearer ${TOKEN}`)
        .set('Host', `attacker.example.com:${port}`)
        .send({ projectPath: '/tmp/project', prompt: 'x' });

      expect(res.status).toBe(403);
    });
  });
});
