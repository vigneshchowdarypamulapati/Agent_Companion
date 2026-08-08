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
    expect(await received).toMatchObject({ kind: 'event', sessionId: 'sess-1', event });
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
});
