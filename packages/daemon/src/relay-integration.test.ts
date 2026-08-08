import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer, InMemoryStore, InMemoryPubSub } from '@companion/relay';
import { RelayClient } from './relay-client.js';
import type { Command, SessionEvent } from '@companion/protocol';

async function pair(httpServer: Server, deviceType: 'daemon' | 'browser', deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send();
  const redeemRes = await request(httpServer)
    .post('/pairing/redeem')
    .send({ code: codeRes.body.code, deviceType, deviceName });
  return redeemRes.body.token as string;
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

describe('daemon <-> relay integration', () => {
  let httpServer: Server;
  let relayClient: RelayClient | undefined;
  let browserWs: WebSocket | undefined;

  afterEach(async () => {
    relayClient?.close();
    browserWs?.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('forwards a daemon-emitted event to a connected browser, and a browser command back to the daemon', async () => {
    httpServer = await createRelayServer({ store: new InMemoryStore(), pubsub: new InMemoryPubSub() });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const daemonToken = await pair(httpServer, 'daemon', 'laptop');
    const browserToken = await pair(httpServer, 'browser', 'phone');

    const receivedCommands: Command[] = [];
    const daemonOpened = new Promise<void>((resolve) => {
      relayClient = new RelayClient({
        url: `ws://127.0.0.1:${port}`,
        token: daemonToken,
        onCommand: (command) => receivedCommands.push(command),
        onOpen: () => resolve(),
      });
    });
    relayClient!.connect();
    await daemonOpened;

    browserWs = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${browserToken}`);
    await new Promise<void>((resolve, reject) => {
      browserWs!.once('open', () => resolve());
      browserWs!.once('error', reject);
    });

    const browserReceived = waitForMessage(browserWs);
    const event: SessionEvent = {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: Date.now(),
    };
    relayClient!.sendEvent('sess-1', event);

    const forwarded = await browserReceived;
    expect(forwarded).toMatchObject({ kind: 'event', sessionId: 'sess-1', event });
    expect(typeof forwarded.seq).toBe('number');

    const command: Command = { type: 'pause', sessionId: 'sess-1' };
    browserWs.send(JSON.stringify({ kind: 'command', sessionId: 'sess-1', command }));

    await expect.poll(() => receivedCommands.length, { timeout: 2000 }).toBeGreaterThan(0);
    expect(receivedCommands[0]).toEqual(command);
  });
});
