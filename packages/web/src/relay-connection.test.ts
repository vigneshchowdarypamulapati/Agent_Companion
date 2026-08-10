// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RelayConnection } from './relay-connection';
import type { Command, SessionEvent } from '@companion/protocol';

function startFakeRelay(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, port });
    });
  });
}

function waitForConnection(wss: WebSocketServer): Promise<NodeWebSocket> {
  return new Promise((resolve) => {
    wss.once('connection', (ws) => resolve(ws));
  });
}

describe('RelayConnection', () => {
  let wss: WebSocketServer;
  let connection: RelayConnection | undefined;

  afterEach(async () => {
    connection?.close();
    connection = undefined;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('connects with the token in the query string and forwards a sent command', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let receivedUrl = '';
    const serverConnected = new Promise<NodeWebSocket>((resolve) => {
      wss.once('connection', (ws, req) => {
        receivedUrl = req.url ?? '';
        resolve(ws);
      });
    });

    const opened = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onEvent: () => {},
        onOpen: () => resolve(),
      });
    });
    connection!.connect();

    const [serverSocket] = await Promise.all([serverConnected, opened]);
    expect(receivedUrl).toMatch(/^\/ws\?.*token=test-token/);

    const received = new Promise<any>((resolve) => {
      serverSocket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const command: Command = { type: 'pause', sessionId: 'sess-1' };
    connection!.sendCommand('sess-1', command);
    expect(await received).toMatchObject({ kind: 'command', sessionId: 'sess-1', command });
  });

  it('invokes onEvent when the server sends an event frame', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const received = new Promise<any>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onEvent: (message) => resolve(message),
      });
    });
    connection!.connect();

    const serverSocket = await serverConnected;
    const event: SessionEvent = { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() };
    serverSocket.send(JSON.stringify({ kind: 'event', sessionId: 'sess-1', seq: 7, event }));

    expect(await received).toEqual({ sessionId: 'sess-1', seq: 7, event });
  });

  it('does not throw when sendCommand is called before the socket is open', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    connection = new RelayConnection({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onEvent: () => {} });
    expect(() =>
      connection!.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' })
    ).not.toThrow();
  });

  it('calls onClose when the connection drops', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const closed = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onEvent: () => {},
        onClose: () => resolve(),
        initialBackoffMs: 10,
        maxBackoffMs: 50,
      });
    });
    connection!.connect();

    const serverSocket = await serverConnected;
    serverSocket.close();

    await closed;
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

    connection = new RelayConnection({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 'test-token',
      onEvent: () => {},
      initialBackoffMs: 10,
      maxBackoffMs: 50,
    });
    connection.connect();

    await secondConnection;
    expect(connectionCount).toBe(2);
  });

  it('does not reconnect and calls onUnauthorized when the server closes with code 4401', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    let connectionCount = 0;
    wss.on('connection', () => {
      connectionCount += 1;
    });

    const unauthorized = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onEvent: () => {},
        onUnauthorized: () => resolve(),
        initialBackoffMs: 10,
        maxBackoffMs: 50,
      });
    });
    connection!.connect();

    const serverSocket = await serverConnected;
    serverSocket.close(4401);

    await unauthorized;
    // Give any (incorrect) reconnect attempt time to happen before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connectionCount).toBe(1);
  });

  it('does not reconnect and calls onUnauthorized when the server closes with code 4403', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    let connectionCount = 0;
    wss.on('connection', () => {
      connectionCount += 1;
    });

    const unauthorized = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onEvent: () => {},
        onUnauthorized: () => resolve(),
        initialBackoffMs: 10,
        maxBackoffMs: 50,
      });
    });
    connection!.connect();

    const serverSocket = await serverConnected;
    serverSocket.close(4403);

    await unauthorized;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connectionCount).toBe(1);
  });
});
