import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer } from './server.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';

function waitForMessage(ws: WebSocket): Promise<unknown> {
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
    httpServer = createRelayServer({ store, pubsub });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonCodeRes = await request(httpServer).post('/pairing/request-code').send();
    const daemonRedeemRes = await request(httpServer)
      .post('/pairing/redeem')
      .send({ code: daemonCodeRes.body.code, deviceType: 'daemon', deviceName: 'laptop' });
    const daemonToken = daemonRedeemRes.body.token as string;

    const browserCodeRes = await request(httpServer).post('/pairing/request-code').send();
    const browserRedeemRes = await request(httpServer)
      .post('/pairing/redeem')
      .send({ code: browserCodeRes.body.code, deviceType: 'browser', deviceName: 'phone' });
    const browserToken = browserRedeemRes.body.token as string;

    const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${daemonToken}`);
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    sockets.push(daemonWs, browserWs);
    await Promise.all([waitForOpen(daemonWs), waitForOpen(browserWs)]);

    const browserReceived = waitForMessage(browserWs);
    daemonWs.send(
      JSON.stringify({
        kind: 'event',
        sessionId: 'sess-1',
        event: {
          type: 'session_started',
          sessionId: 'sess-1',
          projectPath: '/tmp/project',
          at: Date.now(),
        },
      })
    );
    expect(await browserReceived).toMatchObject({ kind: 'event', sessionId: 'sess-1' });

    const eventsRes = await request(httpServer).get('/sessions/sess-1/events');
    expect(eventsRes.body).toHaveLength(1);

    const sessionRes = await request(httpServer).get('/sessions/sess-1');
    expect(sessionRes.body).toMatchObject({ id: 'sess-1', status: 'running' });

    const daemonReceived = waitForMessage(daemonWs);
    browserWs.send(
      JSON.stringify({ kind: 'command', sessionId: 'sess-1', command: { type: 'pause', sessionId: 'sess-1' } })
    );
    expect(await daemonReceived).toMatchObject({ kind: 'command', sessionId: 'sess-1' });
  });

  it('rejects a WS connection with an invalid token', async () => {
    httpServer = createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=not-a-real-token`);
    sockets.push(ws);
    const closeCode = await new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(closeCode).toBe(4401);
  });

  it('returns 400 for an invalid pairing redeem request', async () => {
    httpServer = createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).post('/pairing/redeem').send({ code: '000000' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown session id', async () => {
    httpServer = createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/sessions/does-not-exist');
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

    httpServer = createRelayServer({ store: throwingStore, pubsub });
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
});
