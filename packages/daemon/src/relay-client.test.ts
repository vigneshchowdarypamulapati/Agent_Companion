import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RelayClient } from './relay-client.js';
import type { Command, SessionEvent } from '@companion/protocol';

function startFakeRelay(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, port });
    });
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function waitForConnection(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => {
    wss.once('connection', (ws) => resolve(ws));
  });
}

describe('RelayClient', () => {
  let wss: WebSocketServer;
  let client: RelayClient | undefined;

  afterEach(async () => {
    client?.close();
    client = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('connects with the token in the query string and forwards a sent event', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let receivedUrl = '';
    const serverConnected = new Promise<WebSocket>((resolve) => {
      wss.once('connection', (ws, req) => {
        receivedUrl = req.url ?? '';
        resolve(ws);
      });
    });

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onOpen: () => resolve(),
      });
    });
    client!.connect();

    const [serverSocket] = await Promise.all([serverConnected, clientOpened]);
    expect(receivedUrl).toMatch(/^\/ws\?.*token=test-token/);

    const received = waitForMessage(serverSocket);
    const event: SessionEvent = { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() };
    client!.sendEvent('sess-1', event);
    expect(await received).toMatchObject({ kind: 'event', sessionId: 'sess-1', deliverySeq: 1, event });
  });

  it('assigns increasing deliverySeq values across successive sent events', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    const serverConnected = waitForConnection(wss);
    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onOpen: () => resolve(),
      });
    });
    client!.connect();
    const [serverSocket] = await Promise.all([serverConnected, clientOpened]);

    const firstReceived = waitForMessage(serverSocket);
    client!.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() });
    expect((await firstReceived).deliverySeq).toBe(1);

    const secondReceived = waitForMessage(serverSocket);
    client!.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() });
    expect((await secondReceived).deliverySeq).toBe(2);
  });

  it('invokes onCommand when the server sends a command frame', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const commandReceived = new Promise<Command>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: (command) => resolve(command),
      });
    });
    client!.connect();

    const serverSocket = await connected;
    const command: Command = { type: 'pause', sessionId: 'sess-1' };
    serverSocket.send(JSON.stringify({ kind: 'command', sessionId: 'sess-1', command }));

    expect(await commandReceived).toEqual(command);
  });

  it('does not throw when sendEvent is called before the socket is open', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    client = new RelayClient({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onCommand: () => {} });
    // Note: connect() deliberately not called — there is no socket yet.
    expect(() =>
      client!.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() })
    ).not.toThrow();
  });

  it('reconnects with backoff after the server closes the connection', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let connectionCount = 0;
    const secondConnection = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectionCount += 1;
        if (connectionCount === 1) {
          ws.close();
        } else {
          resolve();
        }
      });
    });

    client = new RelayClient({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 'test-token',
      onCommand: () => {},
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    });
    client.connect();

    await secondConnection;
    expect(connectionCount).toBe(2);
  });

  it('does not reset backoff when the relay closes the connection before openConfirmMs', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    // Every connection is closed the instant it is accepted — the shape of an
    // auth rejection, where the relay accepts the upgrade and only then closes
    // with 4401. Backoff must keep growing across these attempts.
    const connectedAt: number[] = [];
    const thirdConnection = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectedAt.push(Date.now());
        ws.close();
        if (connectedAt.length === 3) resolve();
      });
    });

    client = new RelayClient({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 'test-token',
      onCommand: () => {},
      initialBackoffMs: 50,
      maxBackoffMs: 10_000,
      openConfirmMs: 20,
    });
    client.connect();

    await thirdConnection;

    const firstGap = connectedAt[1] - connectedAt[0];
    const secondGap = connectedAt[2] - connectedAt[1];
    // 50ms then 100ms if backoff kept growing; a flat ~50ms both times would
    // mean 'open' had reset it despite the immediate close.
    expect(secondGap).toBeGreaterThan(75);
    expect(secondGap).toBeGreaterThan(firstGap);
  });

  it('resets backoff once a connection has stayed open past openConfirmMs', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    const connectedAt: number[] = [];
    let closedStableAt = 0;
    const fourthConnection = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectedAt.push(Date.now());
        if (connectedAt.length <= 2) {
          // Grow the backoff: 50ms then 100ms.
          ws.close();
          return;
        }
        if (connectedAt.length === 3) {
          // Hold this one open well past openConfirmMs so the confirm timer fires.
          setTimeout(() => {
            closedStableAt = Date.now();
            ws.close();
          }, 100);
          return;
        }
        resolve();
      });
    });

    client = new RelayClient({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 'test-token',
      onCommand: () => {},
      initialBackoffMs: 50,
      maxBackoffMs: 10_000,
      openConfirmMs: 20,
    });
    client.connect();

    await fourthConnection;

    const gapAfterStableConnection = connectedAt[3] - closedStableAt;
    // Reset means the next attempt waits ~50ms. Without the reset it would have
    // waited the grown backoff of ~200ms.
    expect(gapAfterStableConnection).toBeLessThan(150);
  });

  it('does not leak the token into a log line when the relay URL is malformed', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss; // unused here, but the shared teardown closes it

    const logs: string[] = [];
    client = new RelayClient({
      // `new WebSocket('not-a-url/ws?token=...')` throws synchronously, and the
      // thrown message quotes the entire URL — token included.
      url: 'not-a-url',
      token: 'SUPERSECRET',
      onCommand: () => {},
      onLog: (message) => logs.push(message),
      // Long enough that no retry attempt happens during this test.
      initialBackoffMs: 10_000,
    });

    expect(() => client!.connect()).not.toThrow();

    expect(logs.length).toBeGreaterThan(0);
    for (const message of logs) {
      expect(message).not.toContain('SUPERSECRET');
      expect(message).not.toContain('token=');
    }
    expect(logs.join('\n')).toContain('invalid COMPANION_RELAY_URL');
  });
});
