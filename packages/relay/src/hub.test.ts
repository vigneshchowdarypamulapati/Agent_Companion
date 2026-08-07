import { describe, it, expect, vi } from 'vitest';
import { ConnectionHub, type Connection, type RelayHubMessage } from './hub.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';

function fakeConnection(overrides: Partial<Connection> = {}): Connection & { sent: RelayHubMessage[] } {
  const sent: RelayHubMessage[] = [];
  return {
    deviceId: 'device-1',
    userId: 'user-1',
    deviceType: 'browser',
    send: (message) => sent.push(message),
    sent,
    ...overrides,
  };
}

describe('ConnectionHub', () => {
  it('routing a session_started event from a daemon creates the session record', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    const session = await store.getSession('sess-1');
    expect(session).toMatchObject({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'daemon-1',
      status: 'running',
    });
  });

  it('forwards an event from a daemon to browser connections of the same user only', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const myBrowser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    const otherUsersBrowser = fakeConnection({ deviceId: 'browser-2', deviceType: 'browser', userId: 'user-2' });
    hub.register(myBrowser);
    hub.register(otherUsersBrowser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(myBrowser.sent).toHaveLength(1);
    expect(myBrowser.sent[0]).toMatchObject({ kind: 'event', sessionId: 'sess-1' });
    expect(otherUsersBrowser.sent).toHaveLength(0);
  });

  it('updates session status based on subsequent event types and persists the event', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'permission_request',
      sessionId: 'sess-1',
      requestId: 'req-1',
      toolName: 'Bash',
      input: {},
      at: 2,
    });

    const session = await store.getSession('sess-1');
    expect(session?.status).toBe('waiting_permission');

    const events = await store.getSessionEvents('sess-1');
    expect(events).toHaveLength(2);
  });

  it('routes a command from a browser to the daemon connection that owns the session', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(browser, 'sess-1', { type: 'pause', sessionId: 'sess-1' });

    expect(daemon.sent).toHaveLength(1);
    expect(daemon.sent[0]).toMatchObject({ kind: 'command', sessionId: 'sess-1' });
  });

  it('routeFromBrowser throws for an unknown session', async () => {
    const hub = new ConnectionHub(new InMemoryStore(), new InMemoryPubSub());
    const browser = fakeConnection();

    await expect(
      hub.routeFromBrowser(browser, 'does-not-exist', { type: 'pause', sessionId: 'does-not-exist' })
    ).rejects.toThrow();
  });

  it('routeFromBrowser throws when the session belongs to a different user', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    const intruder = fakeConnection({ deviceId: 'browser-x', deviceType: 'browser', userId: 'user-2' });

    await expect(
      hub.routeFromBrowser(intruder, 'sess-1', { type: 'pause', sessionId: 'sess-1' })
    ).rejects.toThrow();
  });

  it('unregister removes a connection so it no longer receives events', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);
    hub.unregister('browser-1');

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(browser.sent).toHaveLength(0);
  });
});
