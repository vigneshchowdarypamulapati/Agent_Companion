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
import { FakeIdentityVerifier } from './identity-verifier.js';
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

const FAKE_CLERK_TOKEN = 'fake-clerk-token';
const OTHER_FAKE_CLERK_TOKEN = 'other-fake-clerk-token';

function makeIdentityVerifier(): FakeIdentityVerifier {
  return new FakeIdentityVerifier(
    new Map([
      [FAKE_CLERK_TOKEN, { clerkUserId: 'clerk-user-1', email: 'test@example.com' }],
      [OTHER_FAKE_CLERK_TOKEN, { clerkUserId: 'clerk-user-2', email: 'other@example.com' }],
    ])
  );
}

/** Registers a browser device via the Clerk-authenticated registration route. */
async function registerBrowser(
  httpServer: Server,
  deviceName: string,
  clerkToken: string = FAKE_CLERK_TOKEN
): Promise<string> {
  const res = await request(httpServer)
    .post('/devices/register-browser')
    .set('Authorization', `Bearer ${clerkToken}`)
    .send({ deviceName });
  return res.body.token as string;
}

/** Opens a daemon WS, starts a session on it, and resolves once the session record exists. */
async function startSession(
  store: InMemoryStore,
  port: number,
  daemonToken: string,
  sessionId: string,
  projectPath: string,
  sockets: WebSocket[]
): Promise<void> {
  const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
  sockets.push(daemonWs);
  await waitForOpen(daemonWs);
  daemonWs.send(
    JSON.stringify({
      kind: 'event',
      sessionId,
      seq: 0,
      event: { type: 'session_started', sessionId, projectPath, at: Date.now() },
    })
  );
  await expect.poll(async () => (await store.getSession(sessionId))?.id, { timeout: 2000 }).toBe(sessionId);
}

/** Runs the daemon pairing handshake (request-code -> claim by browserToken -> poll) and returns the daemon's token. */
async function pairDaemon(httpServer: Server, browserToken: string, deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName });
  await request(httpServer)
    .post('/pairing/claim')
    .set('Authorization', `Bearer ${browserToken}`)
    .send({ code: codeRes.body.code });
  const pollRes = await request(httpServer).post('/pairing/poll').send({ deviceCode: codeRes.body.deviceCode });
  return pollRes.body.token as string;
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
    httpServer = await createRelayServer({ store, pubsub, identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
    sockets.push(ws);
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(4401);
  });

  it('returns 400 for a malformed /pairing/claim request body', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when claiming an unknown code', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: '000000' });

    expect(res.status).toBe(404);
  });

  it('returns 410 when claiming an expired code', async () => {
    let now = 1_000_000;
    const store = new InMemoryStore(() => now);
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'laptop' });

    now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute TTL

    const claimRes = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: codeRes.body.code });

    expect(claimRes.status).toBe(410);
    expect(claimRes.body).toEqual({ error: 'Pairing code expired' });
  });

  it('returns 409 with already_claimed when claiming a code a second time', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'laptop' });
    await request(httpServer).post('/pairing/claim').set('Authorization', `Bearer ${browserToken}`).send({ code: codeRes.body.code });

    const secondClaim = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: codeRes.body.code });

    expect(secondClaim.status).toBe(409);
    expect(secondClaim.body).toEqual({ error: 'Pairing code already claimed' });
  });

  it('returns 409 with daemon_exists when the account already has a daemon device', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    await pairDaemon(httpServer, browserToken, 'laptop');

    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'second-laptop' });
    const claimRes = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: codeRes.body.code });

    expect(claimRes.status).toBe(409);
    expect(claimRes.body).toEqual({ error: 'Account already has a paired daemon — unpair it first' });
  });

  it('rate-limits POST /pairing/claim after 10 attempts by the same device', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');

    // A 6-digit code is guessable inside its 5-minute life without this cap.
    for (let i = 0; i < 10; i++) {
      const res = await request(httpServer)
        .post('/pairing/claim')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ code: String(i).padStart(6, '0') });
      expect(res.status).toBe(404);
    }

    const blocked = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: '999999' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many pairing attempts, try again later' });
  });

  it('returns 401 for POST /devices/register-browser without an Authorization header', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/devices/register-browser').send({ deviceName: 'phone' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for POST /devices/register-browser with an invalid Clerk token', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/devices/register-browser')
      .set('Authorization', 'Bearer not-a-real-clerk-token')
      .send({ deviceName: 'phone' });
    expect(res.status).toBe(401);
  });

  it('returns 201 with a token and deviceId for a valid Clerk registration', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/devices/register-browser')
      .set('Authorization', `Bearer ${FAKE_CLERK_TOKEN}`)
      .send({ deviceName: 'phone' });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(typeof res.body.deviceId).toBe('string');
  });

  it('returns 404 for an unknown session id when authenticated', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
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

    httpServer = await createRelayServer({ store: throwingStore, pubsub, identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=any-token`);
    sockets.push(ws);

    // Wait for the connection to close. The close code should be 1011 (internal error),
    // and the entire relay process should still be running (not crashed).
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(1011);

    // Verify the relay is still responsive by making an HTTP request.
    const res = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'x' });
    expect(res.status).toBe(201);
  });

  // --- C1: a malformed WebSocket frame must not crash the process ---

  // FIN=1, RSV1=1 (illegal without a negotiated extension), opcode=1 (text); MASK=1, len=0; 4 mask bytes.
  const MALFORMED_FRAME = Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]);

  it('survives a malformed WebSocket frame instead of crashing the process', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // A tokenless handshake still reaches the frame parser, so this is exploitable pre-auth.
    const anonWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(anonWs);
    anonWs.on('error', () => {});
    await new Promise<void>((resolve) => anonWs.once('upgrade', () => resolve()));
    (anonWs as unknown as { _socket: Socket })._socket.write(MALFORMED_FRAME);

    // And the same frame on a fully established, authenticated connection.
    const browserToken = await registerBrowser(httpServer, 'phone');
    const token = await pairDaemon(httpServer, browserToken, 'laptop');
    const authedWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(authedWs);
    authedWs.on('error', () => {});
    await waitForOpen(authedWs);
    (authedWs as unknown as { _socket: Socket })._socket.write(MALFORMED_FRAME);
    await new Promise<void>((resolve) => authedWs.once('close', () => resolve()));

    // The process must still be alive and serving.
    const res = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'x' });
    expect(res.status).toBe(201);
  });

  // --- C3: REST session routes require authentication and ownership ---

  it('returns 401 for GET /sessions/:id and /events without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    expect((await request(httpServer).get('/sessions/sess-1')).status).toBe(401);
    expect((await request(httpServer).get('/sessions/sess-1/events')).status).toBe(401);
  });

  it('returns 401 for a malformed or unknown bearer token', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    expect((await request(httpServer).get('/sessions/sess-1').set('Authorization', 'nonsense')).status).toBe(401);
    expect(
      (await request(httpServer).get('/sessions/sess-1').set('Authorization', 'Bearer bogus')).status
    ).toBe(401);
  });

  it("returns 404 (not 403) when a device from another user asks for a session it doesn't own", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');
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

  // --- cross-account isolation, through the real registration path ---

  it('two different Clerk identities get fully isolated accounts', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // Two real users, each registering through /devices/register-browser with
    // their own Clerk identity — no fabricated device rows anywhere here.
    const aliceToken = await registerBrowser(httpServer, 'alice-phone', FAKE_CLERK_TOKEN);
    const bobToken = await registerBrowser(httpServer, 'bob-phone', OTHER_FAKE_CLERK_TOKEN);
    expect(aliceToken).not.toBe(bobToken);

    // Each pairs its own daemon — the one-daemon-per-account rule is per
    // account, so both succeeding is itself evidence they're separate accounts.
    const aliceDaemon = await pairDaemon(httpServer, aliceToken, 'alice-laptop');
    const bobDaemon = await pairDaemon(httpServer, bobToken, 'bob-laptop');
    expect(typeof aliceDaemon).toBe('string');
    expect(typeof bobDaemon).toBe('string');

    await startSession(store, port, aliceDaemon, 'sess-alice', '/alice/secret', sockets);
    await startSession(store, port, bobDaemon, 'sess-bob', '/bob/secret', sockets);

    // Neither sees the other's session in their active list...
    const aliceList = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${aliceToken}`);
    expect(aliceList.body.map((s: { id: string }) => s.id)).toEqual(['sess-alice']);
    const bobList = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${bobToken}`);
    expect(bobList.body.map((s: { id: string }) => s.id)).toEqual(['sess-bob']);

    // ...nor by asking for it directly by id (404, not 403 — see the ownership tests above).
    const aliceProbingBob = await request(httpServer)
      .get('/sessions/sess-bob')
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(aliceProbingBob.status).toBe(404);
    const bobProbingAlice = await request(httpServer)
      .get('/sessions/sess-alice/events')
      .set('Authorization', `Bearer ${bobToken}`);
    expect(bobProbingAlice.status).toBe(404);
  });

  it('two browsers registering with the same Clerk identity land on the same account', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    // Same Clerk user, two distinct browsers (phone and laptop): distinct
    // device tokens, but one account behind them.
    const phoneToken = await registerBrowser(httpServer, 'phone', FAKE_CLERK_TOKEN);
    const laptopToken = await registerBrowser(httpServer, 'laptop', FAKE_CLERK_TOKEN);
    expect(phoneToken).not.toBe(laptopToken);

    // The daemon is paired by the phone only...
    const daemonToken = await pairDaemon(httpServer, phoneToken, 'work-laptop');
    await startSession(store, port, daemonToken, 'sess-1', '/tmp/project', sockets);

    // ...and the laptop browser, which never touched that pairing, still sees it.
    const laptopList = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${laptopToken}`);
    expect(laptopList.status).toBe(200);
    expect(laptopList.body.map((s: { id: string }) => s.id)).toEqual(['sess-1']);

    const laptopDetail = await request(httpServer).get('/sessions/sess-1').set('Authorization', `Bearer ${laptopToken}`);
    expect(laptopDetail.status).toBe(200);

    // And the one-daemon-per-account rule is shared too: the second browser
    // cannot pair a second daemon, because it's the same account.
    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'second-laptop' });
    const claimRes = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${laptopToken}`)
      .send({ code: codeRes.body.code });
    expect(claimRes.status).toBe(409);
  });

  // --- diagnostic error frame instead of silent drop ---

  it('replies with a diagnostic error frame when a routed message is rejected', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
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
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer).get('/sessions/active').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 401 for GET /sessions/active without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/active');
    expect(res.status).toBe(401);
  });

  // --- POST /sessions/:id/dismiss ---

  it('dismisses a stopped session and removes it from the active list', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer)
      .post('/sessions/does-not-exist/dismiss')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 401 for POST /sessions/:id/dismiss without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/sessions/sess-1/dismiss');
    expect(res.status).toBe(401);
  });

  // --- GET /devices/me ---

  it("returns the authenticated device's own info", async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
    const res = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: 'browser', name: 'phone' });
    expect(res.body.id).toEqual(expect.any(String));
    expect(res.body.createdAt).toEqual(expect.any(Number));
    expect(res.body).not.toHaveProperty('tokenHash');
    expect(res.body).not.toHaveProperty('userId');
  });

  it('returns 401 for GET /devices/me without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/devices/me');
    expect(res.status).toBe(401);
  });

  // --- POST /devices/unpair ---

  it('unpairs the device: the endpoint succeeds and the token stops authenticating', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');

    const unpairRes = await request(httpServer).post('/devices/unpair').set('Authorization', `Bearer ${token}`);
    expect(unpairRes.status).toBe(200);
    expect(unpairRes.body).toEqual({ ok: true });

    const followUp = await request(httpServer).get('/devices/me').set('Authorization', `Bearer ${token}`);
    expect(followUp.status).toBe(401);
  });

  it('returns 401 for POST /devices/unpair without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/devices/unpair');
    expect(res.status).toBe(401);
  });

  it('force-closes every other live connection authenticated as the unpaired device', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const token = await registerBrowser(httpServer, 'phone');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(404);
  });

  it('returns the configured VAPID public key', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      vapidPublicKey: 'test-public-key',
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: 'test-public-key' });
  });

  it('returns 401 for POST /devices/push-subscription without an Authorization header', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/devices/push-subscription')
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(401);
  });

  it('returns 400 for POST /devices/push-subscription with an invalid subscription body', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
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
    httpServer = await createRelayServer({
      store,
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      pushSender,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const token = await registerBrowser(httpServer, 'phone');
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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).delete('/devices/push-subscription');
    expect(res.status).toBe(401);
  });
});
