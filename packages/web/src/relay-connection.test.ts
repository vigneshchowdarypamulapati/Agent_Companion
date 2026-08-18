// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket as NodeWebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { RelayConnection, jitter } from './relay-connection';
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
    const receivedMessage = await received;
    expect(receivedMessage).toMatchObject({ kind: 'command', sessionId: 'sess-1', command });
    expect(typeof receivedMessage.commandId).toBe('string');
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

  // --- command_ack: queue-while-offline, flush-on-reconnect, ack, and timeout ---

  it('resolves onCommandAck with the ack the relay sends back', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const acks: any[] = [];
    connection = new RelayConnection({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 't',
      onEvent: () => {},
      onCommandAck: (commandId, result) => acks.push({ commandId, ...result }),
    });
    connection!.connect();
    const serverSocket = await serverConnected;

    const received = new Promise<any>((resolve) => {
      serverSocket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const commandId = connection!.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' });
    const forwarded = await received;
    expect(forwarded.commandId).toBe(commandId);

    serverSocket.send(JSON.stringify({ kind: 'command_ack', commandId, status: 'delivered' }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acks).toEqual([{ commandId, status: 'delivered', message: undefined }]);
  });

  it('queues a command sent while disconnected and transmits it once the connection opens', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    connection = new RelayConnection({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onEvent: () => {} });
    // Note: connect() deliberately not called yet — this is the exact regression: a command
    // sent while there is no socket at all must not be dropped.
    const commandId = connection!.sendCommand('sess-1', { type: 'inject_prompt', sessionId: 'sess-1', text: 'hi' });

    const serverConnected = waitForConnection(wss);
    connection!.connect();
    const serverSocket = await serverConnected;

    const received = new Promise<any>((resolve) => {
      serverSocket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(await received).toMatchObject({
      kind: 'command',
      sessionId: 'sess-1',
      commandId,
      command: { type: 'inject_prompt', sessionId: 'sess-1', text: 'hi' },
    });
  });

  it('reports a failed ack via onCommandAck after commandAckTimeoutMs elapses with no ack', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    const acks: any[] = [];
    connection = new RelayConnection({
      url: `ws://127.0.0.1:${fake.port}`,
      token: 't',
      onEvent: () => {},
      onCommandAck: (commandId, result) => acks.push({ commandId, ...result }),
      commandAckTimeoutMs: 30,
    });
    // Never connected — the command stays queued forever, so the timeout is what has to fire.
    const commandId = connection!.sendCommand('sess-1', { type: 'inject_prompt', sessionId: 'sess-1', text: 'hi' });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(acks).toHaveLength(1);
    expect(acks[0].commandId).toBe(commandId);
    expect(acks[0].status).toBe('failed');
    expect(acks[0].message).toBeTruthy();
  });

  it('does not retransmit a command that was already sent once but never acked', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let connectionCount = 0;
    const messagesByConnection: any[][] = [];
    const secondConnection = new Promise<void>((resolve) => {
      wss.on('connection', (ws) => {
        connectionCount += 1;
        const index = connectionCount - 1;
        const messages: any[] = [];
        messagesByConnection.push(messages);
        ws.on('message', (data) => {
          messages.push(JSON.parse(data.toString()));
          // Close only the first connection, and only after it actually received the command —
          // otherwise the close could race sendCommand below and this test would prove nothing.
          if (index === 0) ws.close();
        });
        if (index === 1) resolve();
      });
    });

    let firstOpenResolved = false;
    const firstOpen = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        initialBackoffMs: 10,
        maxBackoffMs: 50,
        commandAckTimeoutMs: 5000,
        onOpen: () => {
          if (!firstOpenResolved) {
            firstOpenResolved = true;
            resolve();
          }
        },
      });
    });
    connection!.connect();
    await firstOpen;

    connection!.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' });

    await secondConnection;
    // The command was transmitted on the first connection (and never acked before it closed).
    // Reconnecting must not send it a second time.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messagesByConnection[0]).toHaveLength(1);
    expect(messagesByConnection[1] ?? []).toEqual([]);
  });

  // --- callDaemon: promise-based device-scoped RPC ---

  it('resolves callDaemon with the result the relay sends back', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const opened = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        onOpen: () => resolve(),
      });
    });
    connection!.connect();
    const [serverSocket] = await Promise.all([serverConnected, opened]);

    const received = new Promise<any>((resolve) => {
      serverSocket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const resultPromise = connection!.callDaemon('ping', undefined);
    const frame = await received;
    expect(frame).toMatchObject({ kind: 'rpc_request', method: 'ping', params: null });
    expect(typeof frame.requestId).toBe('string');

    serverSocket.send(
      JSON.stringify({ kind: 'rpc_response', requestId: frame.requestId, result: { version: '1.0.0', uptimeMs: 5 } })
    );
    await expect(resultPromise).resolves.toEqual({ version: '1.0.0', uptimeMs: 5 });
  });

  it('rejects callDaemon with a typed RpcError when the relay sends an error result', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const opened = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        onOpen: () => resolve(),
      });
    });
    connection!.connect();
    const [serverSocket] = await Promise.all([serverConnected, opened]);

    const received = new Promise<any>((resolve) => {
      serverSocket.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    const resultPromise = connection!.callDaemon('ping');
    const frame = await received;

    serverSocket.send(JSON.stringify({ kind: 'rpc_response', requestId: frame.requestId, error: 'no_daemon' }));
    await expect(resultPromise).rejects.toMatchObject({ name: 'RpcError', code: 'no_daemon' });
  });

  it('rejects callDaemon immediately with NOT_CONNECTED when the socket is not open, without queueing it', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    connection = new RelayConnection({ url: `ws://127.0.0.1:${fake.port}`, token: 't', onEvent: () => {} });
    // Note: connect() deliberately not called — there is no socket yet.

    await expect(connection!.callDaemon('ping')).rejects.toMatchObject({ name: 'RpcError', code: 'not_connected' });
  });

  it('rejects callDaemon with a typed TIMEOUT error after rpcTimeoutMs elapses with no response', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const opened = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        onOpen: () => resolve(),
        rpcTimeoutMs: 30,
      });
    });
    connection!.connect();
    await Promise.all([serverConnected, opened]);

    await expect(connection!.callDaemon('ping')).rejects.toMatchObject({ name: 'RpcError', code: 'timeout' });
  });

  it('rejects every still-pending callDaemon call when close() is called', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;
    const serverConnected = waitForConnection(wss);

    const opened = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        onOpen: () => resolve(),
      });
    });
    connection!.connect();
    await Promise.all([serverConnected, opened]);

    const pending = connection!.callDaemon('ping');
    connection!.close();

    await expect(pending).rejects.toMatchObject({ name: 'RpcError', code: 'not_connected' });
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
    connection!.connect();

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

  // --- checkLiveness: the visibilitychange/online-triggered probe ---

  it('forces a reconnect when the socket is OPEN but has been silent past livenessProbeThresholdMs', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let connectionCount = 0;
    const secondConnection = new Promise<void>((resolve) => {
      wss.on('connection', () => {
        connectionCount += 1;
        if (connectionCount === 2) resolve();
      });
    });

    const firstOpen = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        livenessProbeThresholdMs: 20,
        onOpen: () => resolve(),
      });
    });
    connection!.connect();
    await firstOpen;

    // The socket genuinely is still OPEN — nothing severed it — but no frame has arrived in
    // over livenessProbeThresholdMs, which is exactly the "dead but reads OPEN" case this exists
    // to catch (a phone waking from sleep can't tell the difference on its own).
    await new Promise((resolve) => setTimeout(resolve, 40));
    connection!.checkLiveness();

    await secondConnection;
    expect(connectionCount).toBe(2);
  });

  it('does not reconnect when checkLiveness is called on a socket that has heard from the relay recently', async () => {
    const fake = await startFakeRelay();
    wss = fake.wss;

    let connectionCount = 0;
    wss.on('connection', () => {
      connectionCount += 1;
    });

    const firstOpen = new Promise<void>((resolve) => {
      connection = new RelayConnection({
        url: `ws://127.0.0.1:${fake.port}`,
        token: 't',
        onEvent: () => {},
        livenessProbeThresholdMs: 10_000,
        onOpen: () => resolve(),
      });
    });
    connection!.connect();
    await firstOpen;

    connection!.checkLiveness();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connectionCount).toBe(1);
  });

  it('checkLiveness jumps the backoff queue and retries immediately when the socket is not open', async () => {
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
      token: 't',
      onEvent: () => {},
      // A long backoff that checkLiveness must skip past rather than wait out.
      initialBackoffMs: 5_000,
      maxBackoffMs: 5_000,
    });
    connection!.connect();

    // Give the first connection a moment to be accepted and closed, putting the connection into
    // its mid-backoff wait before we probe it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    connection!.checkLiveness();

    await secondConnection;
    expect(connectionCount).toBe(2);
  });
});

// --- jitter: equal jitter applied to the reconnect backoff ---
//
// Stubs Math.random() to fixed values rather than sampling real draws and checking a statistical
// property (e.g. a chi-squared test) over many trials — see jitter's doc comment in
// relay-connection.ts for why: this codebase already had a flaky, unseeded statistical test of
// this shape fail in CI once and had to replace it with exactly this deterministic approach.
describe('jitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exactly ms/2 at the floor of Math.random()', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(jitter(1000)).toBe(500);
  });

  it('returns exactly ms at the ceiling of Math.random()', () => {
    // Math.random() itself never actually returns 1, but stubbing it to 1 exercises the formula's
    // theoretical upper bound directly, which sampling real draws could only ever approach.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    expect(jitter(1000)).toBe(1000);
  });

  it('stays within [ms/2, ms] for a fixed set of representative random draws', () => {
    for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      const result = jitter(2000);
      expect(result).toBeGreaterThanOrEqual(1000);
      expect(result).toBeLessThanOrEqual(2000);
    }
  });

  it('is a pure function of ms and the random draw, with no hidden state across calls', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    expect(jitter(800)).toBe(jitter(800));
  });

  it('scales linearly with ms for a fixed random draw, so the stored exponential backoff curve is not itself randomized — only spread out', () => {
    // scheduleReconnect's backoffMs doubles cleanly on its own (500 -> 1000 -> 2000 -> 4000 -> ...)
    // and jitter is applied on top of that, once, at the moment a reconnect is scheduled. If
    // jitter mixed in any ms-independent noise (or non-linear behavior), doubling the input
    // wouldn't exactly double the output for the same random draw, and the underlying exponential
    // shape would blur across scales instead of just being spread within each step.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const steps = [500, 1000, 2000, 4000];
    const jittered = steps.map((ms) => jitter(ms));
    for (let i = 1; i < jittered.length; i += 1) {
      expect(jittered[i]).toBe(jittered[i - 1] * 2);
    }
  });
});
