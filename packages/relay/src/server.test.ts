import { describe, it, expect, afterEach, vi } from 'vitest';
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
      deliverySeq: 1,
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
        // The daemon assigns its own deliverySeq; the relay assigns the authoritative store
        // seq separately once it persists the event (asserted on the forwarded browser copy).
        deliverySeq: 1,
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
      JSON.stringify({ kind: 'command', sessionId: 'sess-1', commandId: 'cmd-1', command: { type: 'pause', sessionId: 'sess-1' } })
    );
    const forwardedCommand = await daemonReceived;
    expect(forwardedCommand).toMatchObject({ kind: 'command', sessionId: 'sess-1', commandId: 'cmd-1' });
  });

  it("routes a daemon's command_ack back to the browser that sent the command", async () => {
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

    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        deliverySeq: 1,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await waitForMessage(browserWs); // the session_started event echoed to the browser

    const daemonReceived = waitForMessage(daemonWs);
    browserWs.send(
      JSON.stringify({ kind: 'command', sessionId: 'sess-1', commandId: 'cmd-1', command: { type: 'pause', sessionId: 'sess-1' } })
    );
    await daemonReceived;

    const browserReceivedAck = waitForMessage(browserWs);
    daemonWs.send(JSON.stringify({ kind: 'command_ack', commandId: 'cmd-1', status: 'delivered' }));
    expect(await browserReceivedAck).toEqual({ kind: 'command_ack', commandId: 'cmd-1', status: 'delivered' });
  });

  it('routes an rpc_request from a browser to its daemon, and the rpc_response back to that browser', async () => {
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

    const daemonReceived = waitForMessage(daemonWs);
    browserWs.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: null }));
    const forwardedRequest = await daemonReceived;
    expect(forwardedRequest).toMatchObject({ kind: 'rpc_request', requestId: 'req-1', method: 'ping' });

    const browserReceived = waitForMessage(browserWs);
    daemonWs.send(JSON.stringify({ kind: 'rpc_response', requestId: 'req-1', result: { version: '0.1.0', uptimeMs: 5 } }));
    expect(await browserReceived).toEqual({
      kind: 'rpc_response',
      requestId: 'req-1',
      result: { version: '0.1.0', uptimeMs: 5 },
    });
  });

  it("replies with a typed no_daemon rpc_response when the browser's account has no paired daemon", async () => {
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
    browserWs.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: null }));
    expect(await received).toEqual({ kind: 'rpc_response', requestId: 'req-1', error: 'no_daemon' });
  });

  it("does not let one user's browser address another user's daemon via rpc_request", async () => {
    const store = new InMemoryStore();
    const pubsub = new InMemoryPubSub();
    httpServer = await createRelayServer({ store, pubsub, identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ownerBrowserToken = await registerBrowser(httpServer, 'phone', FAKE_CLERK_TOKEN);
    const daemonToken = await pairDaemon(httpServer, ownerBrowserToken, 'laptop');
    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);

    const intruderBrowserToken = await registerBrowser(httpServer, 'intruder-phone', OTHER_FAKE_CLERK_TOKEN);
    const intruderWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${intruderBrowserToken}`);
    sockets.push(intruderWs);
    await waitForOpen(intruderWs);

    const daemonReceivedAnything = waitForMessage(daemonWs);
    const intruderReceived = waitForMessage(intruderWs);
    intruderWs.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: null }));

    expect(await intruderReceived).toEqual({ kind: 'rpc_response', requestId: 'req-1', error: 'no_daemon' });
    // The other user's daemon never sees the intruder's request at all.
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        deliverySeq: 1,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect(daemonReceivedAnything).resolves.toEqual({ kind: 'event_ack', deliverySeq: 1 });
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
      .send({ code: 'ZZZZZZZZ' });

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

    // This in-memory limiter is one of two independent defenses (see the
    // comment above claimLimiter in server.ts) — the other, the persistent
    // per-code failed-attempt lockout, is exercised separately below.
    for (let i = 0; i < 10; i++) {
      const res = await request(httpServer)
        .post('/pairing/claim')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ code: String(i).padStart(8, '0') });
      expect(res.status).toBe(404);
    }

    const blocked = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: 'ZZZZZZZZ' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many pairing attempts, try again later' });
  });

  it('the persistent per-account claim-failure limiter survives a process restart, unlike the in-memory claimLimiter', async () => {
    // One shared Store across two separate createRelayServer() calls, each
    // with its own brand-new in-memory claimLimiter — simulating a restart
    // between them. The store is what's actually durable.
    const store = new InMemoryStore();

    const firstServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => firstServer.listen(0, resolve));
    const browserToken = await registerBrowser(firstServer, 'phone');

    // Exactly CLAIM_FAILURE_LIMIT (10) failed guesses — enough to trip the
    // persistent limiter, but not the 11th call the in-memory claimLimiter
    // would need to trip on its own, so this test is really exercising the
    // persistent one.
    for (let i = 0; i < 10; i++) {
      const res = await request(firstServer)
        .post('/pairing/claim')
        .set('Authorization', `Bearer ${browserToken}`)
        .send({ code: String(i).padStart(8, '0') });
      expect(res.status).toBe(404);
    }
    await new Promise<void>((resolve) => firstServer.close(() => resolve()));

    // "Restart": a fresh server, fresh in-memory claimLimiter, same store.
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    // A real, currently-valid code — proving the 429 below is the account
    // limiter firing, not an incidental 404/410 the fresh in-memory
    // claimLimiter would have let through anyway.
    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'laptop' });
    const res = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: codeRes.body.code });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: 'Too many pairing attempts, try again later' });
  });

  it('a rate-limited account gets the same 429 whether the submitted code exists or not — the limiter cannot be used to enumerate codes', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    // Look the account's real userId up directly through the store (the
    // API itself deliberately never exposes it — see GET /devices/me in
    // README.md) so failures can be pre-seeded against the right account.
    const tokenHash = createHash('sha256').update(browserToken).digest('hex');
    const device = await store.getDeviceByTokenHash(tokenHash);
    const userId = device!.userId;

    for (let i = 0; i < 10; i++) await store.recordFailedClaim(userId);
    expect(await store.isClaimRateLimited(userId)).toBe(true);

    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'laptop' });

    // Both a real, currently-claimable code and a nonexistent one get
    // identical 429s once the account itself is over its persistent
    // limit — checked before either code is even looked up.
    const withRealCode = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: codeRes.body.code });
    const withFakeCode = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: 'ZZZZZZZZ' });

    expect(withRealCode.status).toBe(429);
    expect(withFakeCode.status).toBe(429);
    expect(withRealCode.body).toEqual(withFakeCode.body);
  });

  it('accepts a pairing code typed with different case, hyphens, and whitespace', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const browserToken = await registerBrowser(httpServer, 'phone');
    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'laptop' });
    const rawCode = codeRes.body.code as string;
    const typedAsHumanWould = ` ${rawCode.slice(0, 4)}-${rawCode.slice(4)}`.toLowerCase();

    const claimRes = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${browserToken}`)
      .send({ code: typedAsHumanWould });

    expect(claimRes.status).toBe(200);
  });

  it('invalidates a code after 5 failed claims, reporting 410 (same as expiry) instead of 409', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    // Two independent accounts, so this exercises the persistent per-code
    // lockout specifically, not the in-memory per-account claimLimiter
    // (10/5min) covered by the test above — 5 attempts stays well under it.
    const victimToken = await registerBrowser(httpServer, 'victim-phone', FAKE_CLERK_TOKEN);
    const attackerToken = await registerBrowser(httpServer, 'attacker-phone', OTHER_FAKE_CLERK_TOKEN);
    const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'laptop' });

    const claimed = await request(httpServer)
      .post('/pairing/claim')
      .set('Authorization', `Bearer ${victimToken}`)
      .send({ code: codeRes.body.code });
    expect(claimed.status).toBe(200);

    const responses = [];
    for (let i = 0; i < 5; i++) {
      responses.push(
        await request(httpServer)
          .post('/pairing/claim')
          .set('Authorization', `Bearer ${attackerToken}`)
          .send({ code: codeRes.body.code })
      );
    }
    const last = responses[responses.length - 1];
    expect(last.status).toBe(410);
    expect(last.body).toEqual({ error: 'Pairing code expired' });
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

  it('rate-limits POST /devices/register-browser after 10 registrations by the same Clerk identity, independent of IP', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    // Same Clerk token (same verified identity) every time, so this proves the
    // account-keyed limiter — not the loose pre-auth IP guard (cap 60) — is
    // what actually kicks in at 10.
    for (let i = 0; i < 10; i++) {
      const res = await request(httpServer)
        .post('/devices/register-browser')
        .set('Authorization', `Bearer ${FAKE_CLERK_TOKEN}`)
        .send({ deviceName: `device-${i}` });
      expect(res.status).toBe(201);
    }

    const blocked = await request(httpServer)
      .post('/devices/register-browser')
      .set('Authorization', `Bearer ${FAKE_CLERK_TOKEN}`)
      .send({ deviceName: 'device-11' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: 'Too many pairing attempts, try again later' });

    // A different Clerk identity is a different account, so it isn't blocked.
    const other = await request(httpServer)
      .post('/devices/register-browser')
      .set('Authorization', `Bearer ${OTHER_FAKE_CLERK_TOKEN}`)
      .send({ deviceName: 'other-device' });
    expect(other.status).toBe(201);
  });

  // --- trust proxy / X-Forwarded-For handling for the IP-keyed request-code limiter ---

  it('with trustProxyHops set, different X-Forwarded-For values get independent /pairing/request-code buckets', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      trustProxyHops: 1,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    for (let i = 0; i < 20; i++) {
      const res = await request(httpServer)
        .post('/pairing/request-code')
        .set('X-Forwarded-For', '1.2.3.4')
        .send({ deviceName: 'x' });
      expect(res.status).toBe(201);
    }
    const blocked = await request(httpServer)
      .post('/pairing/request-code')
      .set('X-Forwarded-For', '1.2.3.4')
      .send({ deviceName: 'x' });
    expect(blocked.status).toBe(429);

    // A different forwarded client IP is a separate bucket — only possible
    // if Express is actually honoring X-Forwarded-For for one trusted hop.
    const otherIp = await request(httpServer)
      .post('/pairing/request-code')
      .set('X-Forwarded-For', '5.6.7.8')
      .send({ deviceName: 'x' });
    expect(otherIp.status).toBe(201);
  });

  it('with trustProxyHops unset (default), X-Forwarded-For is ignored and both headers share one bucket', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    for (let i = 0; i < 20; i++) {
      const res = await request(httpServer)
        .post('/pairing/request-code')
        .set('X-Forwarded-For', '1.2.3.4')
        .send({ deviceName: 'x' });
      expect(res.status).toBe(201);
    }

    // A different forwarded-for header does NOT grant a fresh bucket by
    // default: nothing is trusted, so req.ip is the real socket address
    // (the same one for every request in this test) regardless of the header.
    const stillBlocked = await request(httpServer)
      .post('/pairing/request-code')
      .set('X-Forwarded-For', '5.6.7.8')
      .send({ deviceName: 'x' });
    expect(stillBlocked.status).toBe(429);
  });

  it('warns once when X-Forwarded-For arrives while trust proxy hop count is 0, and not at all without the header', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      // trustProxyHops omitted — defaults to 0, same as the default-unset case above.
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    // No X-Forwarded-For header at all: never warns.
    await request(httpServer).post('/pairing/request-code').send({ deviceName: 'x' });
    expect(warnSpy).not.toHaveBeenCalled();

    // Repeated requests carrying the header: warns exactly once, not per request.
    for (let i = 0; i < 5; i++) {
      await request(httpServer)
        .post('/pairing/request-code')
        .set('X-Forwarded-For', '1.2.3.4')
        .send({ deviceName: 'x' });
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/X-Forwarded-For/);

    warnSpy.mockRestore();
  });

  // --- CORS ---

  it('reflects an allowed origin and sets credentials-free CORS headers', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      corsOrigins: ['http://localhost:5173'],
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/pairing/request-code')
      .set('Origin', 'http://localhost:5173')
      .send({ deviceName: 'x' });

    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not set an Access-Control-Allow-Origin header for a disallowed origin', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      corsOrigins: ['http://localhost:5173'],
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/pairing/request-code')
      .set('Origin', 'https://evil.example.com')
      .send({ deviceName: 'x' });

    // The browser (not the server) is what actually blocks the response from
    // being read when the origin isn't reflected — the request itself still
    // completes server-side, but no CORS header means the browser refuses it.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('defaults corsOrigins to the Vite dev server origin when unset', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer)
      .post('/pairing/request-code')
      .set('Origin', 'http://localhost:5173')
      .send({ deviceName: 'x' });

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
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
        deliverySeq: 1,
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
        commandId: 'cmd-1',
        command: { type: 'pause', sessionId: 'nope' },
      })
    );
    expect(await received).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown session') });
  });

  it('replies with a diagnostic error frame for non-JSON text and survives it', async () => {
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
    browserWs.send('not valid json');
    expect(await received).toMatchObject({ kind: 'error' });

    // The connection survives — a follow-up valid message still gets routed normally.
    const received2 = waitForMessage(browserWs);
    browserWs.send(
      JSON.stringify({ kind: 'command', sessionId: 'nope', commandId: 'cmd-1', command: { type: 'pause', sessionId: 'nope' } })
    );
    expect(await received2).toMatchObject({ kind: 'error', message: expect.stringContaining('Unknown session') });
  });

  it('replies with a diagnostic error frame for a syntactically valid but unrecognized message kind', async () => {
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
    browserWs.send(JSON.stringify({ kind: 'not_a_real_kind', foo: 'bar' }));
    expect(await received).toMatchObject({ kind: 'error' });
  });

  // --- event_ack: daemon receives an ack once its event is durably stored ---

  it('sends event_ack over the wire once the daemon-sent event is durably stored', async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({ store, pubsub: new InMemoryPubSub(), identityVerifier: makeIdentityVerifier() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');
    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);

    const ack = waitForMessage(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        deliverySeq: 1,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    expect(await ack).toEqual({ kind: 'event_ack', deliverySeq: 1 });
  });

  // --- maxPayload: an oversized frame is rejected, not crashed on ---

  it('rejects a frame larger than maxPayload without crashing the connection or the process', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      maxPayloadBytes: 1024,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(browserWs);
    browserWs.on('error', () => {});
    await waitForOpen(browserWs);

    const closed = new Promise<void>((resolve) => browserWs.once('close', () => resolve()));
    browserWs.send(JSON.stringify({ kind: 'rpc_request', requestId: '1', method: 'x', params: 'x'.repeat(2000) }));
    await closed;

    // The relay process is still alive and serving other connections.
    const res = await request(httpServer).post('/pairing/request-code').send({ deviceName: 'x' });
    expect(res.status).toBe(201);
  });

  // --- heartbeat: an unresponsive connection is terminated via the same cleanup path as a normal close ---

  it("terminates a connection that stops answering pings, and runs the daemon's normal disconnect cleanup", async () => {
    const store = new InMemoryStore();
    httpServer = await createRelayServer({
      store,
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      heartbeatIntervalMs: 1000,
      heartbeatMaxMissedPongs: 2,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

    // autoPong: false — this socket receives ping frames but never answers them, simulating a
    // half-open connection (the transport looks alive; the peer never actually responds).
    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`, { autoPong: false });
    sockets.push(daemonWs);
    daemonWs.on('error', () => {});
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        deliverySeq: 1,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: Date.now() },
      })
    );
    await expect.poll(async () => (await store.getSession('sess-1'))?.id, { timeout: 2000 }).toBe('sess-1');

    vi.useFakeTimers();
    try {
      const closeCode = new Promise<number>((resolve) => daemonWs.once('close', (code) => resolve(code)));
      // 3 heartbeat ticks: 2 misses confirmed, terminated on the 3rd — see
      // DEFAULT_HEARTBEAT_MAX_MISSED_PONGS's doc comment in server.ts for why it's 3, not 2.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await closeCode).toBe(1006);

      // Same cleanup path as a normal close, including hub.ts's daemon-disconnect grace period
      // (default 30s): advancing past it marks the orphaned session stopped, exactly as an
      // ordinary daemon disconnect would.
      await vi.advanceTimersByTimeAsync(30_000);
      await expect.poll(async () => (await store.getSession('sess-1'))?.status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
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
        deliverySeq: 1,
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
        deliverySeq: 1,
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
        deliverySeq: 1,
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
        deliverySeq: 1,
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

  // --- GET /devices/daemon-status ---

  it('GET /devices/daemon-status returns paired: false when the account has no daemon', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const browserToken = await registerBrowser(httpServer, 'my-browser');

    const res = await request(httpServer)
      .get('/devices/daemon-status')
      .set('Authorization', `Bearer ${browserToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paired: false });
  });

  it('GET /devices/daemon-status returns paired: true once a daemon is paired to the account', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const browserToken = await registerBrowser(httpServer, 'my-browser');
    await pairDaemon(httpServer, browserToken, 'my-daemon');

    const res = await request(httpServer)
      .get('/devices/daemon-status')
      .set('Authorization', `Bearer ${browserToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paired: true });
  });

  it('GET /devices/daemon-status returns 401 when unauthenticated', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/devices/daemon-status');

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

  // --- health check ---

  it('answers GET /health with 200 and no authentication, so a platform probe can reach it', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    // No Authorization header — this is the whole point: every other route 401s without one, so
    // a health check that required auth would tell the platform the service is broken.
    const res = await request(httpServer).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health reveals nothing beyond liveness', async () => {
    // Reachable by anyone on the internet, so it must not become a place where configuration,
    // versions, or connection counts leak out as the relay grows.
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
      vapidPublicKey: 'test-public-key',
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/health');
    expect(Object.keys(res.body)).toEqual(['status']);
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
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } });
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
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' });
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
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } });
    expect(subscribeRes.status).toBe(200);

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    sockets.push(daemonWs);
    await waitForOpen(daemonWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        deliverySeq: 1,
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
        deliverySeq: 1,
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
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } });

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
