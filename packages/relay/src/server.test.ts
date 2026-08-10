import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import type { PushSender } from './push-sender.js';

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

/** Runs the full pairing handshake and returns the device token. */
async function pair(httpServer: Server, deviceType: 'daemon' | 'browser', deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send();
  const redeemRes = await request(httpServer)
    .post('/pairing/redeem')
    .send({ code: codeRes.body.code, deviceType, deviceName });
  return redeemRes.body.token as string;
}

describe('relay server', () => {
  let httpServer: Server;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) ws.close();
    sockets = [];
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('pairs a daemon and a browser, then routes an event and a command between them', async () => {
    const store = new InMemoryStore();
    const pubsub = new InMemoryPubSub();
    httpServer = await createRelayServer({ store, pubsub });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(daemonWs, browserWs);
    await Promise.all([waitForOpen(daemonWs), waitForOpen(browserWs)]);

    const browserReceived = waitForMessage(browserWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        // The relay assigns the authoritative seq; the inbound value is ignored.
        seq: 0,
        event: {
          type: 'session_started',
          sessionId: 'sess-1',
          projectPath: '/tmp/project',
          at: Date.now(),
        },
      })
    );
    const forwarded = await browserReceived;
    expect(forwarded).toMatchObject({ kind: 'event', sessionId: 'sess-1', seq: 1 });

    const eventsRes = await request(httpServer)
      .get('/sessions/sess-1/events')
      .set('Authorization', `Bearer ${browserToken}`);
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.body).toHaveLength(1);
    expect(eventsRes.body[0].seq).toBe(forwarded.seq);

    const sessionRes = await request(httpServer)
      .get('/sessions/sess-1')
      .set('Authorization', `Bearer ${daemonToken}`);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body).toMatchObject({ id: 'sess-1', status: 'running' });

    const daemonReceived = waitForMessage(daemonWs);
    browserWs.send(
      JSON.stringify({ kind: 'command', sessionId: 'sess-1', command: { type: 'pause', sessionId: 'sess-1' } })
    );
    expect(await daemonReceived).toMatchObject({ kind: 'command', sessionId: 'sess-1' });
  });

  it('rejects a WS connection with an invalid token', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
    sockets.push(ws);
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(4401);
  });

  it('returns 400 for an invalid pairing redeem request', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/pairing/redeem').send({ code: '000000' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session id when authenticated', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer).get('/sessions/does-not-exist').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('closes WS connection cleanly if Store.getDeviceByTokenHash throws', async () => {
    const baseStore = new InMemoryStore();
    const pubsub = new InMemoryPubSub();

    // Create a wrapper store that throws on getDeviceByTokenHash.
    const throwingStore = Object.create(baseStore) as typeof baseStore;
    throwingStore.getDeviceByTokenHash = async () => {
      throw new Error('Store connection failed');
    };

    httpServer = await createRelayServer({ store: throwingStore, pubsub });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=any-token`);
    sockets.push(ws);

    // Wait for the connection to close. The close code should be 1011 (internal error),
    // and the entire relay process should still be running (not crashed).
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(1011);

    // Verify the relay is still responsive by making an HTTP request.
    const res = await request(httpServer).post('/pairing/request-code').send();
    expect(res.status).toBe(201);
  });

  // --- C1: a malformed WebSocket frame must not crash the process ---

  // FIN=1, RSV1=1 (illegal without a negotiated extension), opcode=1 (text); MASK=1, len=0; 4 mask bytes.
  const MALFORMED_FRAME = Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]);

  it('survives a malformed WebSocket frame instead of crashing the process', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // A tokenless handshake still reaches the frame parser, so this is exploitable pre-auth.
    const anonWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(anonWs);
    anonWs.on('error', () => {});
    await new Promise<void>((resolve) => anonWs.once('upgrade', () => resolve()));
    (anonWs as unknown as { _socket: Socket })._socket.write(MALFORMED_FRAME);

    // And the same frame on a fully established, authenticated connection.
    const token = await pair(httpServer, 'daemon', 'laptop');
    const authedWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(authedWs);
    authedWs.on('error', () => {});
    await waitForOpen(authedWs);
    (authedWs as unknown as { _socket: Socket })._socket.write(MALFORMED_FRAME);
    await new Promise<void>((resolve) => authedWs.once('close', () => resolve()));

    // The process must still be alive and serving.
    const res = await request(httpServer).post('/pairing/request-code').send();
    expect(res.status).toBe(201);
  });

  // --- C3: REST session routes require authentication and ownership ---

  it('returns 401 for GET /sessions/:id and /events without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    expect((await request(httpServer).get('/sessions/sess-1')).status).toBe(401);
    expect((await request(httpServer).get('/sessions/sess-1/events')).status).toBe(401);
  });

  it('returns 401 for a malformed or unknown bearer token', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    expect((await request(httpServer).get('/sessions/sess-1').set('Authorization', 'nonsense')).status).toBe(401);
    expect(
      (await request(httpServer).get('/sessions/sess-1').set('Authorization', 'Bearer bogus')).status
    ).toBe(401);
  });

  it("returns 404 (not 403) when a device from another user asks for a session it doesn't own", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/secret', at: Date.now() },
      })
    );
    // Wait until the session record exists.
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    // A device belonging to a completely different user.
    const intruderToken = 'intruder-token';
    await store.createDevice({
      userId: 'some-other-user',
      type: 'browser',
      name: 'attacker',
      tokenHash: createHash('sha256').update(intruderToken).digest('hex'),
    });

    const sessionRes = await request(httpServer)
      .get('/sessions/sess-1')
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(sessionRes.status).toBe(404);
    expect(sessionRes.body).toEqual({ error: 'Unknown session' });

    const eventsRes = await request(httpServer)
      .get('/sessions/sess-1/events')
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(eventsRes.status).toBe(404);
  });

  // --- diagnostic error frame instead of silent drop ---

  it('replies with a diagnostic error frame when a routed message is rejected', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await pair(httpServer, 'browser', 'phone');
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(browserWs);
    await waitForOpen(browserWs);

    const received = waitForMessage(browserWs);
    browserWs.send(
      JSON.stringify({
        kind: 'command',
        sessionId: 'nope',
        command: { type: 'pause', sessionId: 'nope' },
      })
    );
    expect(await received).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown session') });
  });

  // --- GET /sessions/active ---

  it("returns the authenticated device's active sessions", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${browserToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'sess-1', status: 'running' });
  });

  it('returns an empty array when there is no active session', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 for GET /sessions/active without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/active');
    expect(res.status).toBe(401);
  });

  // --- POST /sessions/:id/dismiss ---

  it('dismisses a stopped session and removes it from the active list', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    // Wait for session_started to land before sending stopped: both events are handled by
    // detached async tasks per WS message, so without this the stopped handler's ownership
    // check can run before upsertSession completes and the event gets dropped as "unknown session".
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.status, { timeout: 2000 })
      .toBe('running');
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'stopped', sessionId: 'sess-1', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.status, { timeout: 2000 })
      .toBe('stopped');

    const dismissRes = await request(httpServer)
      .post('/sessions/sess-1/dismiss')
      .set('Authorization', `Bearer ${browserToken}`);
    expect(dismissRes.status).toBe(200);

    const listRes = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${browserToken}`);
    expect(listRes.body).toEqual([]);
  });

  it('returns 409 when dismissing a session that is not stopped', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');

    const res = await request(httpServer)
      .post('/sessions/sess-1/dismiss')
      .set('Authorization', `Bearer ${browserToken}`);
    expect(res.status).toBe(409);
  });

  it('returns 404 when dismissing an unknown session', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer)
      .post('/sessions/does-not-exist/dismiss')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 401 for POST /sessions/:id/dismiss without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/sessions/sess-1/dismiss');
    expect(res.status).toBe(401);
  });

  // --- GET /devices/me ---

  it("returns the authenticated device's own info", async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'browser', name: 'phone' });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(Number));
    expect(res.body).not.toHaveProperty('tokenHash');
    expect(res.body).not.toHaveProperty('userId');
  });

  it('returns 401 for GET /devices/me without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/devices/me');
    expect(res.status).toBe(401);
  });

  // --- POST /devices/unpair ---

  it('unpairs the device: the endpoint succeeds and the token stops authenticating', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');

    const unpairRes = await request(httpServer).post('/devices/unpair').set('Authorization', `Bearer ${token}`);
    expect(unpairRes.status).toBe(200);
    expect(unpairRes.body).toEqual({ ok: true });

    const followUp = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);
    expect(followUp.status).toBe(401);
  });

  it('returns 401 for POST /devices/unpair without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/devices/unpair');
    expect(res.status).toBe(401);
  });

  it('force-closes every other live connection authenticated as the unpaired device', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const token = await pair(httpServer, 'browser', 'phone');

    // Two tabs sharing the same paired browser's token.
    const tabA = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const tabB = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(tabA, tabB);
    await Promise.all([waitForOpen(tabA), waitForOpen(tabB)]);

    const tabACloses = new Promise<number>((resolve) => tabA.once('close', (code) => resolve(code)));
    const tabBCloses = new Promise<number>((resolve) => tabB.once('close', (code) => resolve(code)));

    const unpairRes = await request(httpServer).post('/devices/unpair').set('Authorization', `Bearer ${token}`);
    expect(unpairRes.status).toBe(200);

    expect(await tabACloses).toBe(4403);
    expect(await tabBCloses).toBe(4403);
  });

  // --- push notifications ---

  it('returns 404 for GET /push/vapid-public-key when push is not configured', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(404);
  });

  it('returns the configured VAPID public key', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      vapidPublicKey: 'test-public-key',
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: 'test-public-key' });
  });

  it('returns 401 for POST /devices/push-subscription without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/devices/push-subscription')
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(401);
  });

  it('returns 400 for POST /devices/push-subscription with an invalid subscription body', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    const res = await request(httpServer)
      .post('/devices/push-subscription')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://push.example.com/x' });
    expect(res.status).toBe(400);
  });

  it('a stored push subscription receives a notification when a qualifying event fires', async () => {
    const store = new InMemoryStore();
    const sent: unknown[] = [];
    const pushSender: PushSender = {
      send: async (subscription, payload) => {
        sent.push({ subscription, payload });
        return 'ok';
      },
    };
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), pushSender });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const subscribeRes = await request(httpServer)
      .post('/devices/push-subscription')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(subscribeRes.status).toBe(200);

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect
      .poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 })
      .toBe('sess-1');
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        seq: 0,
        event: { type: 'stopped', sessionId: 'sess-1', at: Date.now() },
      })
    );

    await expect.poll(() => sent.length, { timeout: 2000 }).toBe(1);
    expect(sent[0]).toMatchObject({ payload: { title: 'Session stopped', body: '/tmp/project' } });
  });

  it('clears the subscription after DELETE /devices/push-subscription', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await pair(httpServer, 'browser', 'phone');
    await request(httpServer)
      .post('/devices/push-subscription')
      .set('Authorization', `Bearer ${token}`)
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });

    const deleteRes = await request(httpServer)
      .delete('/devices/push-subscription')
      .set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });
  });

  it('returns 401 for DELETE /devices/push-subscription without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).delete('/devices/push-subscription');
    expect(res.status).toBe(401);
  });
});
