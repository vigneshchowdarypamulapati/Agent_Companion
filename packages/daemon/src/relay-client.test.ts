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

/**
 * A FIFO queue of parsed messages, for tests that expect several messages in a row (e.g. a
 * replay). Unlike chaining `waitForMessage` calls — which each register a fresh `once` listener
 * only after the previous one resolves — this attaches a single permanent listener up front, so
 * messages that arrive back-to-back in the same synchronous burst (as a replay's sends do) are
 * queued rather than lost while a consumer hasn't called next() yet.
 */
function collectMessages(ws: WebSocket): { next: () => Promise<any> } {
  const queue: any[] = [];
  const waiters: Array<(value: any) => void> = [];
  ws.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else queue.push(parsed);
  });
  return {
    next: () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
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

    const commandReceived = new Promise<{ commandId: string; command: Command }>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: (commandId, command) => resolve({ commandId, command }),
      });
    });
    client!.connect();

    const serverSocket = await connected;
    const command: Command = { type: 'pause', sessionId: 'sess-1' };
    serverSocket.send(JSON.stringify({ kind: 'command', sessionId: 'sess-1', commandId: 'cmd-1', command }));

    expect(await commandReceived).toEqual({ commandId: 'cmd-1', command });
  });

  it('sends a command_ack frame when sendCommandAck is called while connected', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onOpen: () => resolve(),
      });
    });
    client!.connect();
    const [serverSocket] = await Promise.all([connected, clientOpened]);

    const received = waitForMessage(serverSocket);
    client!.sendCommandAck('cmd-1', 'delivered');
    expect(await received).toEqual({ kind: 'command_ack', commandId: 'cmd-1', status: 'delivered' });

    const received2 = waitForMessage(serverSocket);
    client!.sendCommandAck('cmd-2', 'failed', 'Unknown session');
    expect(await received2).toEqual({ kind: 'command_ack', commandId: 'cmd-2', status: 'failed', message: 'Unknown session' });
  });

  it('does not throw and does not send when sendCommandAck is called while disconnected', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    client = new RelayClient({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onCommand: () => {} });
    // Note: connect() deliberately not called — there is no socket yet.
    expect(() => client!.sendCommandAck('cmd-1', 'delivered')).not.toThrow();
  });

  it('runs onRpcRequest for an inbound rpc_request and sends its result back as an rpc_response', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onRpcRequest: (method, params) => ({ result: { method, params } }),
        onOpen: () => resolve(),
      });
    });
    client!.connect();
    const [serverSocket] = await Promise.all([connected, clientOpened]);

    const received = waitForMessage(serverSocket);
    serverSocket.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: null }));

    expect(await received).toEqual({
      kind: 'rpc_response',
      requestId: 'req-1',
      result: { method: 'ping', params: null },
    });
  });

  it('sends a typed error rpc_response when onRpcRequest resolves with an error', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onRpcRequest: () => ({ error: 'unknown_method' }),
        onOpen: () => resolve(),
      });
    });
    client!.connect();
    const [serverSocket] = await Promise.all([connected, clientOpened]);

    const received = waitForMessage(serverSocket);
    serverSocket.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'nope', params: null }));

    expect(await received).toEqual({ kind: 'rpc_response', requestId: 'req-1', error: 'unknown_method' });
  });

  it('sends a typed handler_error rpc_response instead of crashing when onRpcRequest throws', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onRpcRequest: () => {
          throw new Error('boom');
        },
        onOpen: () => resolve(),
      });
    });
    client!.connect();
    const [serverSocket] = await Promise.all([connected, clientOpened]);

    const received = waitForMessage(serverSocket);
    serverSocket.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: null }));

    expect(await received).toEqual({ kind: 'rpc_response', requestId: 'req-1', error: 'handler_error' });
  });

  it('defaults to a typed unknown_method rpc_response when no onRpcRequest is wired in', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const connected = waitForConnection(wss);

    const clientOpened = new Promise<void>((resolve) => {
      client = new RelayClient({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 'test-token',
        onCommand: () => {},
        onOpen: () => resolve(),
      });
    });
    client!.connect();
    const [serverSocket] = await Promise.all([connected, clientOpened]);

    const received = waitForMessage(serverSocket);
    serverSocket.send(JSON.stringify({ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: null }));

    expect(await received).toEqual({ kind: 'rpc_response', requestId: 'req-1', error: 'unknown_method' });
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

  it('buffers events sent while disconnected and replays them in order on reconnect — including a session_started that must not be lost', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    client = new RelayClient({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onCommand: () => {} });
    // Note: connect() deliberately not called — sendEvent must buffer, not drop, while there is
    // no socket at all yet. This is the exact regression: if session_started is lost here, the
    // relay later rejects every event for this session because it never learns the session exists.
    const started: SessionEvent = { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/p', at: 1 };
    const followUp: SessionEvent = { type: 'turn_complete', sessionId: 'sess-1', at: 2 };
    client.sendEvent('sess-1', started);
    client.sendEvent('sess-1', followUp);

    const serverConnected = waitForConnection(wss);
    client.connect();
    const serverSocket = await serverConnected;
    const messages = collectMessages(serverSocket);

    const first = await messages.next();
    const second = await messages.next();
    expect(first).toMatchObject({ kind: 'event', deliverySeq: 1, event: started });
    expect(second).toMatchObject({ kind: 'event', deliverySeq: 2, event: followUp });
  });

  it('does not replay entries the relay has already acknowledged', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    const firstConnection = waitForConnection(wss);
    client = new RelayClient({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 't',
      onCommand: () => {},
      // Long enough that the reconnect (after we deliberately close below) cannot fire before
      // the disconnected sendEvent() call further down has definitely run and buffered.
      initialBackoffMs: 300,
      maxBackoffMs: 300,
    });
    client.connect();
    const firstSocket = await firstConnection;

    const acked = waitForMessage(firstSocket);
    client.sendEvent('sess-1', { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/p', at: 1 });
    expect((await acked).deliverySeq).toBe(1);

    firstSocket.send(JSON.stringify({ kind: 'event_ack', deliverySeq: 1 }));

    firstSocket.close();
    // Give the client time to process the ack and observe the close (readyState settle to
    // non-OPEN) before sending the next event, so that send deterministically buffers instead of
    // racing the close handshake. initialBackoffMs (300ms) keeps the automatic reconnect from
    // firing before this wait — and the sendEvent below — complete.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const secondConnection = waitForConnection(wss);
    client.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });
    const secondSocket = await secondConnection;

    // Only the unacked deliverySeq 2 should be replayed — not the already-acked deliverySeq 1.
    const replayed = await waitForMessage(secondSocket);
    expect(replayed.deliverySeq).toBe(2);
  });

  it('prepends an events_dropped marker before the next new send for a session that lost buffered entries', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    client = new RelayClient({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 't',
      onCommand: () => {},
      maxBufferedEvents: 1,
    });
    // Still not connected: both sends buffer. The buffer only holds 1 entry, so the first
    // (session_started) is evicted to make room for the second, marking sess-1 for a drop marker.
    client.sendEvent('sess-1', { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/p', at: 1 });
    client.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });

    const serverConnected = waitForConnection(wss);
    client.connect();
    const serverSocket = await serverConnected;
    const messages = collectMessages(serverSocket);

    // Replay first delivers whatever survived eviction (deliverySeq 2). Markers are only ever
    // inserted ahead of a newly-generated send (see sendEvent) — never retroactively spliced into
    // a replay — because a replayed entry already carries the deliverySeq it was originally
    // assigned, and a marker manufactured "after the fact" during replay would have to carry a
    // *higher* deliverySeq than entries still queued behind it, breaking the numeric order the
    // relay's future ack/contiguous-seq tracking depends on.
    const replayed = await messages.next();
    expect(replayed.event).toMatchObject({ type: 'turn_complete', sessionId: 'sess-1' });

    client.sendEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 3 });

    const marker = await messages.next();
    const realEvent = await messages.next();
    expect(marker.event).toMatchObject({ type: 'events_dropped', sessionId: 'sess-1' });
    expect(realEvent.event).toMatchObject({ type: 'turn_complete', sessionId: 'sess-1', at: 3 });
    expect(marker.deliverySeq).toBeLessThan(realEvent.deliverySeq);
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
