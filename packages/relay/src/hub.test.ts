import { describe, it, expect } from 'vitest';
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

async function startedHub(store: InMemoryStore, pubsub = new InMemoryPubSub()): Promise<ConnectionHub> {
  const hub = new ConnectionHub(store, pubsub);
  await hub.start();
  return hub;
}

describe('ConnectionHub', () => {
  it('routing a session_started event from a daemon creates the session record', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
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
    const hub = await startedHub(store);
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
    const hub = await startedHub(store);
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
    const hub = await startedHub(store);
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
    const hub = await startedHub(new InMemoryStore());
    const browser = fakeConnection();

    await expect(
      hub.routeFromBrowser(browser, 'does-not-exist', { type: 'pause', sessionId: 'does-not-exist' })
    ).rejects.toThrow();
  });

  it('routeFromBrowser throws when the session belongs to a different user', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
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
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);
    hub.unregister(browser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(browser.sent).toHaveLength(0);
  });

  it('routeFromDaemon throws when a different daemon attempts to mutate a session', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonA = fakeConnection({ deviceId: 'daemon-a', deviceType: 'daemon', userId: 'user-1' });
    const daemonB = fakeConnection({ deviceId: 'daemon-b', deviceType: 'daemon', userId: 'user-1' });

    // Daemon A creates the session
    await hub.routeFromDaemon(daemonA, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    // Verify session was created and owned by daemon A
    let session = await store.getSession('sess-1');
    expect(session?.daemonDeviceId).toBe('daemon-a');
    let events = await store.getSessionEvents('sess-1');
    expect(events).toHaveLength(1);

    // Daemon B attempts to route a turn_complete event for the same session
    await expect(
      hub.routeFromDaemon(daemonB, 'sess-1', {
        type: 'turn_complete',
        sessionId: 'sess-1',
        at: 2,
      })
    ).rejects.toThrow('Unknown session');

    // Verify session status and event log were not mutated
    session = await store.getSession('sess-1');
    expect(session?.status).toBe('running'); // Should still be 'running', not changed
    events = await store.getSessionEvents('sess-1');
    expect(events).toHaveLength(1); // Should still have only 1 event
  });

  // --- C2: session_started replay hijack ---

  it('routeFromDaemon rejects a session_started replay for a session owned by another daemon', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonA = fakeConnection({ deviceId: 'daemon-a', deviceType: 'daemon', userId: 'user-1' });
    const daemonB = fakeConnection({ deviceId: 'daemon-b', deviceType: 'daemon', userId: 'user-1' });

    await hub.routeFromDaemon(daemonA, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project-a',
      at: 1,
    });

    await expect(
      hub.routeFromDaemon(daemonB, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/attacker',
        at: 2,
      })
    ).rejects.toThrow('already owned by a different daemon');

    const session = await store.getSession('sess-1');
    expect(session).toMatchObject({ daemonDeviceId: 'daemon-a', projectPath: '/tmp/project-a' });
    expect(await store.getSessionEvents('sess-1')).toHaveLength(1);
  });

  it('routeFromDaemon allows the owning daemon to re-send session_started', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-a', deviceType: 'daemon', userId: 'user-1' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project-a',
      at: 1,
    });
    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project-a',
        at: 2,
      })
    ).resolves.toBeUndefined();

    expect((await store.getSession('sess-1'))?.daemonDeviceId).toBe('daemon-a');
  });

  // --- C4 / I5: multiple simultaneous connections per deviceId ---

  it('unregistering a stale connection does not evict a newer one for the same deviceId', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);

    // Two successive browser sockets for the same paired device: the second one connects
    // before the first one's close event has fired.
    const staleBrowser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    const liveBrowser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    hub.register(staleBrowser);
    hub.register(liveBrowser);

    // The stale socket's close event finally arrives.
    hub.unregister(staleBrowser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(liveBrowser.sent).toHaveLength(1);
    expect(staleBrowser.sent).toHaveLength(0);
  });

  it('delivers events to every simultaneous connection sharing one deviceId', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    const tabA = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    const tabB = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    hub.register(tabA);
    hub.register(tabB);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(tabA.sent).toHaveLength(1);
    expect(tabB.sent).toHaveLength(1);
  });

  it('delivers a command to every simultaneous connection of the owning daemon device', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonSocketA = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const daemonSocketB = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    hub.register(daemonSocketA);
    hub.register(daemonSocketB);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });

    await hub.routeFromDaemon(daemonSocketA, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(browser, 'sess-1', { type: 'pause', sessionId: 'sess-1' });

    expect(daemonSocketA.sent.filter((m) => m.kind === 'command')).toHaveLength(1);
    expect(daemonSocketB.sent.filter((m) => m.kind === 'command')).toHaveLength(1);
  });

  // --- I1: seq on live events ---

  it('includes the store-assigned seq on events forwarded to browsers', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    hub.register(browser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });

    const stored = await store.getSessionEvents('sess-1');
    expect(browser.sent).toHaveLength(2);
    expect(browser.sent[0]).toMatchObject({ kind: 'event', seq: stored[0].seq });
    expect(browser.sent[1]).toMatchObject({ kind: 'event', seq: stored[1].seq });
    expect(stored[1].seq).toBeGreaterThan(stored[0].seq);
  });

  // --- I2 / I3: envelope/payload cross-check and start_session rejection ---

  it('routeFromBrowser throws when the envelope sessionId does not match the command payload', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });

    await expect(
      hub.routeFromBrowser(browser, 'sess-1', { type: 'stop', sessionId: 'sess-2' })
    ).rejects.toThrow('does not match');
  });

  it('routeFromBrowser rejects start_session commands', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });

    await expect(
      hub.routeFromBrowser(browser, 'sess-1', {
        type: 'start_session',
        projectPath: '/tmp/project',
        prompt: 'hi',
      })
    ).rejects.toThrow('start_session cannot be routed through the relay');
  });

  it('routeFromDaemon throws when the envelope sessionId does not match the event payload', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-2',
        projectPath: '/tmp/project',
        at: 1,
      })
    ).rejects.toThrow('does not match');

    expect(await store.getSession('sess-1')).toBeUndefined();
    expect(await store.getSession('sess-2')).toBeUndefined();
  });

  // --- I4: start() gates delivery ---

  it('does not deliver messages before start() has been awaited', async () => {
    const store = new InMemoryStore();
    const hub = new ConnectionHub(store, new InMemoryPubSub());
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    hub.register(browser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(browser.sent).toHaveLength(0);
  });
});
