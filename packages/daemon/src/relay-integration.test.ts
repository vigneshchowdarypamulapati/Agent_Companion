import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRelayServer, InMemoryStore, InMemoryPubSub, FakeIdentityVerifier } from '@companion/relay';
import { RelayClient } from './relay-client.js';
import type { Command, SessionEvent } from '@companion/protocol';

const FAKE_CLERK_TOKEN = 'fake-clerk-token';

async function registerBrowser(httpServer: Server, deviceName: string): Promise<string> {
  const res = await request(httpServer)
    .post('/devices/register-browser')
    .set('Authorization', `Bearer ${FAKE_CLERK_TOKEN}`)
    .send({ deviceName });
  return res.body.token as string;
}

async function pairDaemon(httpServer: Server, browserToken: string, deviceName: string): Promise<string> {
  const codeRes = await request(httpServer).post('/pairing/request-code').send({ deviceName });
  await request(httpServer)
    .post('/pairing/claim')
    .set('Authorization', `Bearer ${browserToken}`)
    .send({ code: codeRes.body.code });
  const pollRes = await request(httpServer).post('/pairing/poll').send({ deviceCode: codeRes.body.deviceCode });
  return pollRes.body.token as string;
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
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: new FakeIdentityVerifier(
        new Map([[FAKE_CLERK_TOKEN, { clerkUserId: 'clerk-user-1', email: 'test@example.com' }]])
      ),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const browserToken = await registerBrowser(httpServer, 'phone');
    const daemonToken = await pairDaemon(httpServer, browserToken, 'laptop');

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
    browserWs.send(JSON.stringify({ kind: 'command', sessionId: 'sess-1', commandId: 'cmd-1', command }));

    await expect.poll(() => receivedCommands.length, { timeout: 2000 }).toBeGreaterThan(0);
    expect(receivedCommands[0]).toEqual(command);
  });
});
