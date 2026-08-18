import { describe, it, expect, vi } from 'vitest';
import { ConnectionHub, RPC_IN_FLIGHT_CAP_PER_DEVICE, type Connection, type RelayHubMessage } from './hub.js';
import { InMemoryStore } from './in-memory-store.js';
import { InMemoryPubSub } from './in-memory-pubsub.js';
import type { PushPayload, PushSendResult, PushSender } from './push-sender.js';
import type { PushSubscriptionPayload } from '@companion/protocol';

function fakeConnection(overrides: Partial<Connection> = {}): Connection & { sent: RelayHubMessage[]; closed: { value: boolean } } {
  const sent: RelayHubMessage[] = [];
  const closed = { value: false };
  return {
    deviceId: 'device-1',
    userId: 'user-1',
    deviceType: 'browser',
    send: (message) => sent.push(message),
    close: () => {
      closed.value = true;
    },
    sent,
    closed,
    ...overrides,
  };
}

function fakePushSender(result: PushSendResult | 'throw' = 'ok'): PushSender & {
  sent: { subscription: PushSubscriptionPayload; payload: PushPayload }[];
} {
  const sent: { subscription: PushSubscriptionPayload; payload: PushPayload }[] = [];
  return {
    sent,
    send: async (subscription, payload) => {
      sent.push({ subscription, payload });
      if (result === 'throw') throw new Error('push service unavailable');
      return result;
    },
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

  it('sets status to waiting_input on turn_complete, and back to running on the next assistant_text', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });
    expect((await store.getSession('sess-1'))?.status).toBe('waiting_input');

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: 'Starting the next task…',
      at: 3,
    });
    expect((await store.getSession('sess-1'))?.status).toBe('running');
  });

  it('sets status back to running on tool_use after turn_complete', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'tool_use',
      sessionId: 'sess-1',
      toolName: 'Bash',
      input: {},
      at: 3,
    });
    expect((await store.getSession('sess-1'))?.status).toBe('running');
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
    await hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' });

    expect(daemon.sent).toHaveLength(1);
    expect(daemon.sent[0]).toMatchObject({ kind: 'command', sessionId: 'sess-1', commandId: 'cmd-1' });
  });

  it('routeFromBrowser throws for an unknown session', async () => {
    const hub = await startedHub(new InMemoryStore());
    const browser = fakeConnection();

    await expect(
      hub.routeFromBrowser(browser, 'does-not-exist', 'cmd-1', { type: 'pause', sessionId: 'does-not-exist' })
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
      hub.routeFromBrowser(intruder, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' })
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
    await hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' });

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
      hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', { type: 'stop', sessionId: 'sess-2' })
    ).rejects.toThrow('does not match');
  });

  it('routeFromBrowser rejects start_session commands', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });

    await expect(
      hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', {
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

  // --- daemon-disconnect grace period ---

  it("marks a daemon's sessions stopped after the grace period once all its connections close", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pubsub = new InMemoryPubSub();
      const hub = new ConnectionHub(store, pubsub, 1000);
      await hub.start();
      const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
      const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
      hub.register(daemon);
      hub.register(browser);

      await hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project',
        at: 1,
      });

      hub.unregister(daemon);
      await vi.advanceTimersByTimeAsync(1000);

      const session = await store.getSession('sess-1');
      expect(session?.status).toBe('stopped');

      const stoppedEvents = browser.sent.filter(
        (m) => m.kind === 'event' && m.event.type === 'stopped' && m.sessionId === 'sess-1'
      );
      expect(stoppedEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stop sessions if the daemon reconnects within the grace period', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pubsub = new InMemoryPubSub();
      const hub = new ConnectionHub(store, pubsub, 1000);
      await hub.start();
      const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
      hub.register(daemon);

      await hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project',
        at: 1,
      });

      hub.unregister(daemon);
      await vi.advanceTimersByTimeAsync(500);

      const reconnected = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
      hub.register(reconnected);
      await vi.advanceTimersByTimeAsync(1000);

      const session = await store.getSession('sess-1');
      expect(session?.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('only stops sessions owned by the disconnected daemon, not other daemons for the same user', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pubsub = new InMemoryPubSub();
      const hub = new ConnectionHub(store, pubsub, 1000);
      await hub.start();
      const daemonA = fakeConnection({ deviceId: 'daemon-a', deviceType: 'daemon', userId: 'user-1' });
      const daemonB = fakeConnection({ deviceId: 'daemon-b', deviceType: 'daemon', userId: 'user-1' });
      hub.register(daemonA);
      hub.register(daemonB);

      await hub.routeFromDaemon(daemonA, 'sess-a', {
        type: 'session_started',
        sessionId: 'sess-a',
        projectPath: '/tmp/a',
        at: 1,
      });
      await hub.routeFromDaemon(daemonB, 'sess-b', {
        type: 'session_started',
        sessionId: 'sess-b',
        projectPath: '/tmp/b',
        at: 1,
      });

      hub.unregister(daemonA);
      await vi.advanceTimersByTimeAsync(1000);

      expect((await store.getSession('sess-a'))?.status).toBe('stopped');
      expect((await store.getSession('sess-b'))?.status).toBe('running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not append a duplicate stopped event for a session that is already stopped', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pubsub = new InMemoryPubSub();
      const hub = new ConnectionHub(store, pubsub, 1000);
      await hub.start();
      const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
      hub.register(daemon);

      await hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project',
        at: 1,
      });
      await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

      hub.unregister(daemon);
      await vi.advanceTimersByTimeAsync(1000);

      const events = await store.getSessionEvents('sess-1');
      expect(events.filter((e) => e.event.type === 'stopped')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- disconnectDevice (used when a device is unpaired) ---

  it('disconnectDevice closes every live connection for that device', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const tabA = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    const tabB = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    hub.register(tabA);
    hub.register(tabB);

    hub.disconnectDevice('browser-1');

    expect(tabA.closed.value).toBe(true);
    expect(tabB.closed.value).toBe(true);
  });

  it('disconnectDevice does not close connections belonging to a different device', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const target = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser' });
    const other = fakeConnection({ deviceId: 'browser-2', deviceType: 'browser' });
    hub.register(target);
    hub.register(other);

    hub.disconnectDevice('browser-1');

    expect(target.closed.value).toBe(true);
    expect(other.closed.value).toBe(false);
  });

  it('disconnectDevice is a no-op for a device with no live connections', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);

    expect(() => hub.disconnectDevice('does-not-exist')).not.toThrow();
  });

  it("force-closing a daemon's connection via disconnectDevice still triggers the grace-period stop", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pubsub = new InMemoryPubSub();
      const hub = new ConnectionHub(store, pubsub, 1000);
      await hub.start();
      const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
      hub.register(daemon);

      await hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project',
        at: 1,
      });

      hub.disconnectDevice('daemon-1');
      expect(daemon.closed.value).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);

      const session = await store.getSession('sess-1');
      expect(session?.status).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  // --- push notifications ---

  const subscriptionA = { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: 'p-a', auth: 'a-a' } };
  const subscriptionB = { endpoint: 'https://fcm.googleapis.com/fcm/send/b', keys: { p256dh: 'p-b', auth: 'a-b' } };

  it('sends a push notification to a subscribed browser device on a permission_request event', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

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

    expect(pushSender.sent).toHaveLength(1);
    expect(pushSender.sent[0]).toMatchObject({
      subscription: subscriptionA,
      payload: { title: 'Needs your permission', body: '/tmp/project', url: '/sessions/sess-1' },
    });
  });

  it('sends a push notification on error and stopped events', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'error', sessionId: 'sess-1', message: 'boom', at: 2 });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 3 });

    expect(pushSender.sent.map((s) => s.payload.title)).toEqual(['Session error', 'Session stopped']);
  });

  it('sends a push notification on turn_complete with the last assistant message as the body', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: 'Task 1 is done. Want me to continue with task 2, or something else?',
      at: 2,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 3 });

    const turnCompletePush = pushSender.sent.find((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePush?.payload).toMatchObject({
      title: 'Claude is waiting for you',
      body: 'Task 1 is done. Want me to continue with task 2, or something else?',
      url: '/sessions/sess-1',
    });
  });

  it('truncates a long assistant message to 140 characters in the push body', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });
    const longText = 'a'.repeat(200);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: longText,
      at: 2,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 3 });

    const turnCompletePush = pushSender.sent.find((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePush?.payload.body).toBe(`${'a'.repeat(140)}…`);
  });

  it('falls back to the project path in the push body when there is no assistant_text event', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 2 });

    const turnCompletePush = pushSender.sent.find((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePush?.payload.body).toBe('/tmp/project');
  });

  it('falls back to the project path rather than a stale assistant_text from a previous turn', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    // First turn: produces an assistant_text, then completes.
    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'assistant_text',
      sessionId: 'sess-1',
      text: 'first message',
      at: 2,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 3 });
    // Second turn: no assistant_text at all (e.g. a tool-only turn), just completes.
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 4 });

    const turnCompletePushes = pushSender.sent.filter((s) => s.payload.title === 'Claude is waiting for you');
    expect(turnCompletePushes).toHaveLength(2);
    expect(turnCompletePushes[1]?.payload.body).toBe('/tmp/project');
  });

  it('does not send a push notification for a non-qualifying event type', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'command_failed', sessionId: 'sess-1', message: 'boom', at: 2 });

    expect(pushSender.sent).toHaveLength(0);
  });

  it('does not send a push notification to a browser device with no subscription', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent).toHaveLength(0);
  });

  it('sends a push notification to every subscribed browser device for the user', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const deviceA = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    const deviceB = await store.createDevice({
      userId,
      type: 'browser',
      name: 'laptop-browser',
      tokenHash: 'h2',
    });
    await store.setPushSubscription(deviceA.id, subscriptionA);
    await store.setPushSubscription(deviceB.id, subscriptionB);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent.map((s) => s.subscription)).toEqual(expect.arrayContaining([subscriptionA, subscriptionB]));
    expect(pushSender.sent).toHaveLength(2);
  });

  it('does not send a push notification to the daemon device itself', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const daemonDevice = await store.createDevice({ userId, type: 'daemon', name: 'laptop', tokenHash: 'h1' });
    // A daemon device could in principle have a pushSubscription field set (nothing in the
    // Store forbids it); the hub must still never target daemon-typed devices.
    await store.setPushSubscription(daemonDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent).toHaveLength(0);
  });

  it("clears a device's subscription when the push sender reports it is gone", async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender('gone');
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    const devices = await store.getDevicesForUser(userId);
    expect(devices.find((d) => d.id === browserDevice.id)?.pushSubscription).toBeUndefined();
  });

  // --- I2: re-validating stored subscriptions before every send ---

  it('never sends to a stored subscription that fails re-validation, and clears it', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    // Simulates a row written before endpoint validation existed (or by some other write path
    // that skipped it) — an internal/SSRF-shaped endpoint that would never pass
    // PushSubscriptionPayload today. The store itself enforces no schema, so this can only be
    // caught by re-validating immediately before sending.
    const staleInvalidSubscription = {
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      keys: { p256dh: 'p', auth: 'a' },
    } as unknown as PushSubscriptionPayload;
    await store.setPushSubscription(browserDevice.id, staleInvalidSubscription);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    // The critical assertion: the SSRF-shaped endpoint was never POSTed to.
    expect(pushSender.sent).toHaveLength(0);

    // Self-healing: the invalid subscription was cleared, same as the 'gone' handling.
    const devices = await store.getDevicesForUser(userId);
    expect(devices.find((d) => d.id === browserDevice.id)?.pushSubscription).toBeUndefined();
  });

  it('still sends to other valid devices when one device has a stale invalid subscription', async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender();
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const staleDevice = await store.createDevice({ userId, type: 'browser', name: 'old-phone', tokenHash: 'h1' });
    const validDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h2' });
    const staleInvalidSubscription = {
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      keys: { p256dh: 'p', auth: 'a' },
    } as unknown as PushSubscriptionPayload;
    await store.setPushSubscription(staleDevice.id, staleInvalidSubscription);
    await store.setPushSubscription(validDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 });

    expect(pushSender.sent).toHaveLength(1);
    expect(pushSender.sent[0].subscription).toEqual(subscriptionA);
  });

  it("one device's push failure does not prevent another device's push from being sent", async () => {
    const store = new InMemoryStore();
    const pushSender = fakePushSender('throw');
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, undefined, pushSender);
    await hub.start();
    const userId = 'user-1';
    const deviceA = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    const deviceB = await store.createDevice({
      userId,
      type: 'browser',
      name: 'laptop-browser',
      tokenHash: 'h2',
    });
    await store.setPushSubscription(deviceA.id, subscriptionA);
    await store.setPushSubscription(deviceB.id, subscriptionB);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 })
    ).resolves.toBeUndefined();

    // Both sends were attempted despite both throwing — routeFromDaemon itself never rejects.
    expect(pushSender.sent).toHaveLength(2);
  });

  it('does not attempt to send a push notification when no pushSender is configured', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const userId = 'user-1';
    const browserDevice = await store.createDevice({ userId, type: 'browser', name: 'phone', tokenHash: 'h1' });
    await store.setPushSubscription(browserDevice.id, subscriptionA);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', { type: 'stopped', sessionId: 'sess-1', at: 2 })
    ).resolves.toBeUndefined();
  });

  it("a daemon disconnect's grace-period stop also sends a push notification", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryStore();
      const pushSender = fakePushSender();
      const hub = new ConnectionHub(store, new InMemoryPubSub(), 1000, undefined, pushSender);
      await hub.start();
      const userId = 'user-1';
      const browserDevice = await store.createDevice({
        userId,
        type: 'browser',
        name: 'phone',
        tokenHash: 'h1',
      });
      await store.setPushSubscription(browserDevice.id, subscriptionA);
      const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId });
      hub.register(daemon);

      await hub.routeFromDaemon(daemon, 'sess-1', {
        type: 'session_started',
        sessionId: 'sess-1',
        projectPath: '/tmp/project',
        at: 1,
      });

      hub.unregister(daemon);
      await vi.advanceTimersByTimeAsync(1000);

      expect(pushSender.sent).toHaveLength(1);
      expect(pushSender.sent[0].payload.title).toBe('Session stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  // --- event_ack: durability-gated, gap-tolerant delivery acking ---

  it('sends event_ack with the deliverySeq once the event is durably stored', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(
      daemon,
      'sess-1',
      { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: 1 },
      1
    );

    const acks = daemon.sent.filter((m) => m.kind === 'event_ack');
    expect(acks).toEqual([{ kind: 'event_ack', deliverySeq: 1 }]);
  });

  it('does not send event_ack for an event routed without a deliverySeq (pre-Task-3 call sites)', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });

    expect(daemon.sent.filter((m) => m.kind === 'event_ack')).toEqual([]);
  });

  it('advances the ack across a deliverySeq gap instead of stalling, simulating an evicted buffer entry', async () => {
    // Regression case for the bug a reviewer caught in this task: acking "the highest
    // *contiguous* deliverySeq" would permanently wedge at 1 here, since 2 is never sent (it
    // was evicted from the daemon's OutboundBuffer before ever reaching the relay — see
    // outbound-buffer.ts). The relay never receives a deliverySeq of 2 for this connection at
    // all; deliverySeq 3 is simply the next value the daemon actually sends.
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(
      daemon,
      'sess-1',
      { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: 1 },
      1
    );
    // deliverySeq 2 never arrives — the daemon dropped it.
    await hub.routeFromDaemon(
      daemon,
      'sess-1',
      { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 2 },
      3
    );

    const acks = daemon.sent.filter((m) => m.kind === 'event_ack');
    expect(acks).toEqual([
      { kind: 'event_ack', deliverySeq: 1 },
      { kind: 'event_ack', deliverySeq: 3 },
    ]);
  });

  it('does not advance (or send) the ack when the store write fails, and never acks again on that connection even after a later success', async () => {
    const store = new InMemoryStore();
    const failingStore = Object.create(store) as typeof store;
    let shouldFail = false;
    failingStore.appendSessionEvent = async (...args: Parameters<typeof store.appendSessionEvent>) => {
      if (shouldFail) throw new Error('store unavailable');
      return store.appendSessionEvent(...args);
    };
    const hub = await startedHub(failingStore);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(
      daemon,
      'sess-1',
      { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: 1 },
      1
    );
    shouldFail = true;
    await expect(
      hub.routeFromDaemon(daemon, 'sess-1', { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 2 }, 2)
    ).rejects.toThrow('store unavailable');

    // Only the first (successful) store write produced an ack; the failed second one produced none.
    expect(daemon.sent.filter((m) => m.kind === 'event_ack')).toEqual([{ kind: 'event_ack', deliverySeq: 1 }]);

    // A later event whose OWN store write succeeds must NOT advance the ack past the failed one:
    // deliverySeq 2 is still sitting, unstored, in the daemon's buffer, and acking 3 would tell
    // the daemon it's safe to drop 2 as well (OutboundBuffer.acknowledge drops everything <=
    // the acked value) — permanent silent loss of data the relay never actually persisted. This
    // is different from the eviction-gap case: the daemon never decided to skip 2, so it has no
    // independent reason to believe dropping it is safe. See ackDelivery's doc in hub.ts.
    shouldFail = false;
    await hub.routeFromDaemon(
      daemon,
      'sess-1',
      { type: 'assistant_text', sessionId: 'sess-1', text: 'hi again', at: 3 },
      3
    );
    expect(daemon.sent.filter((m) => m.kind === 'event_ack')).toEqual([{ kind: 'event_ack', deliverySeq: 1 }]);
  });

  it('serializes concurrent frames per connection: a later deliverySeq that finishes storing first must not ack past an earlier one that is still in flight and then fails', async () => {
    // Regression test for the review finding on this task: server.ts dispatches each inbound WS
    // frame as an independent, un-awaited async chain, so two 'event' frames for the same daemon
    // connection can start concurrently — exactly what happens on a reconnect replay burst. This
    // test fails without routeFromDaemon's per-connection serialization (daemonProcessingQueues):
    // without it, deliverySeq 2's fast store write would resolve and ack(2) would be sent BEFORE
    // deliverySeq 1's slow store write is even known to fail, silently telling the daemon it's
    // safe to drop deliverySeq 1 (which it never actually stored).
    const store = new InMemoryStore();
    const controllableStore = Object.create(store) as typeof store;
    let releaseSlowWrite!: () => void;
    const slowWriteGate = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });
    controllableStore.appendSessionEvent = async (...args: Parameters<typeof store.appendSessionEvent>) => {
      const [, event] = args;
      if (event.type === 'session_started') {
        // The earlier frame (deliverySeq 1): deliberately held open until the later frame
        // (deliverySeq 2) has had a chance to run, then fails — simulating "the earlier
        // event's write is still in flight when the later one finishes and then fails."
        await slowWriteGate;
        throw new Error('store unavailable for deliverySeq 1');
      }
      // The later frame (deliverySeq 2): resolves immediately, well before the gate above opens.
      return store.appendSessionEvent(...args);
    };
    const hub = await startedHub(controllableStore);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    // Dispatched back-to-back without awaiting the first — mirrors server.ts's un-awaited
    // per-message handlers, which is exactly the shape that would race without serialization.
    const seq1 = hub.routeFromDaemon(
      daemon,
      'sess-1',
      { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: 1 },
      1
    );
    const seq2 = hub.routeFromDaemon(daemon, 'sess-1', { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 2 }, 2);

    // Give the (serialized) queue a turn to actually start processing seq1 and, if unserialized,
    // let seq2 race ahead of it — then release seq1's gate so it can finally fail.
    await Promise.resolve();
    await Promise.resolve();
    releaseSlowWrite();

    const results = await Promise.allSettled([seq1, seq2]);
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');

    // The ack must never have advanced past the still-failed deliverySeq 1 — in particular,
    // never an ack for deliverySeq 2, even though deliverySeq 2's own store write succeeded.
    const acks = daemon.sent.filter((m) => m.kind === 'event_ack');
    expect(acks).toEqual([]);
  });

  it('tracks ack state per connection object, so a reconnected daemon is not assumed to start at deliverySeq 1', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const firstConnection = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });

    await hub.routeFromDaemon(
      firstConnection,
      'sess-1',
      { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: 1 },
      1
    );
    hub.unregister(firstConnection);

    // A reconnect creates a brand-new Connection object (see server.ts) whose replay can
    // legitimately begin at any deliverySeq already assigned by the daemon's still-running
    // counter, e.g. 50 — not 1.
    const reconnected = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon' });
    hub.register(reconnected);
    await hub.routeFromDaemon(
      reconnected,
      'sess-1',
      { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 2 },
      50
    );

    expect(reconnected.sent.filter((m) => m.kind === 'event_ack')).toEqual([{ kind: 'event_ack', deliverySeq: 50 }]);
  });

  // --- command_ack: routing a daemon's delivery outcome back to the originating browser ---

  it('routes a command_ack back to the browser that sent the original command', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' });
    await hub.routeCommandAck(daemon, { kind: 'command_ack', commandId: 'cmd-1', status: 'delivered' });

    const acks = browser.sent.filter((m) => m.kind === 'command_ack');
    expect(acks).toEqual([{ kind: 'command_ack', commandId: 'cmd-1', status: 'delivered', message: undefined }]);
  });

  it('does not route a command_ack to a different browser device belonging to the same user', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const sender = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(sender);
    const otherTab = fakeConnection({ deviceId: 'browser-2', deviceType: 'browser', userId: 'user-1' });
    hub.register(otherTab);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(sender, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' });
    await hub.routeCommandAck(daemon, { kind: 'command_ack', commandId: 'cmd-1', status: 'delivered' });

    expect(sender.sent.filter((m) => m.kind === 'command_ack')).toHaveLength(1);
    expect(otherTab.sent.filter((m) => m.kind === 'command_ack')).toHaveLength(0);
  });

  it('forwards a failed command_ack with its message', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' });
    await hub.routeCommandAck(daemon, {
      kind: 'command_ack',
      commandId: 'cmd-1',
      status: 'failed',
      message: 'Unknown session',
    });

    expect(browser.sent.filter((m) => m.kind === 'command_ack')).toEqual([
      { kind: 'command_ack', commandId: 'cmd-1', status: 'failed', message: 'Unknown session' },
    ]);
  });

  it('silently ignores a command_ack for an unknown or already-routed commandId', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });

    await expect(
      hub.routeCommandAck(daemon, { kind: 'command_ack', commandId: 'does-not-exist', status: 'delivered' })
    ).resolves.toBeUndefined();
  });

  it('does not route a command_ack sent by a daemon connection belonging to a different user', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeFromDaemon(daemon, 'sess-1', {
      type: 'session_started',
      sessionId: 'sess-1',
      projectPath: '/tmp/project',
      at: 1,
    });
    await hub.routeFromBrowser(browser, 'sess-1', 'cmd-1', { type: 'pause', sessionId: 'sess-1' });

    const intruderDaemon = fakeConnection({ deviceId: 'daemon-x', deviceType: 'daemon', userId: 'user-2' });
    await hub.routeCommandAck(intruderDaemon, { kind: 'command_ack', commandId: 'cmd-1', status: 'delivered' });

    expect(browser.sent.filter((m) => m.kind === 'command_ack')).toHaveLength(0);
  });

  // --- rpc_request / rpc_response: the device-scoped RPC channel ---

  it('routes an rpc_request from a browser to that user\'s daemon, and the response back to the originating browser', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeRpcRequest(browser, 'req-1', 'ping', undefined);

    expect(daemon.sent).toEqual([{ kind: 'rpc_request', requestId: 'req-1', method: 'ping', params: undefined }]);

    await hub.routeRpcResponse(daemon, { requestId: 'req-1', result: { version: '0.1.0', uptimeMs: 42 } });

    expect(browser.sent).toEqual([
      { kind: 'rpc_response', requestId: 'req-1', result: { version: '0.1.0', uptimeMs: 42 }, error: undefined },
    ]);
  });

  it('routes an rpc_response only to the originating browser device, not other tabs of the same user', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const sender = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(sender);
    const otherTab = fakeConnection({ deviceId: 'browser-2', deviceType: 'browser', userId: 'user-1' });
    hub.register(otherTab);

    await hub.routeRpcRequest(sender, 'req-1', 'ping', undefined);
    await hub.routeRpcResponse(daemon, { requestId: 'req-1', result: { ok: true } });

    expect(sender.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(1);
    expect(otherTab.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);
  });

  it('another user\'s browser cannot address this daemon: rpc_request is routed only to the requester\'s own daemon', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const intruder = fakeConnection({ deviceId: 'browser-x', deviceType: 'browser', userId: 'user-2' });
    hub.register(intruder);

    await hub.routeRpcRequest(intruder, 'req-1', 'ping', undefined);

    // No daemon paired to user-2, so the intruder gets a typed error, not access to user-1's daemon.
    expect(daemon.sent).toHaveLength(0);
    expect(intruder.sent).toEqual([{ kind: 'rpc_response', requestId: 'req-1', error: 'no_daemon' }]);
  });

  it('with two users who EACH have a connected daemon, a request lands only on the requester\'s own daemon', async () => {
    // The other isolation tests give the intruder no daemon at all, so the only gate they
    // exercise is `getDaemonDeviceForUser` returning undefined. This is the case that actually
    // pins the targeting logic: both users have a live daemon, so a bug that picked the wrong
    // device (or a `dispatchLocal` that stopped re-checking userId) would deliver to the wrong
    // one instead of failing closed. For a channel whose whole premise is that session-ownership
    // checks do not apply, that is the regression worth guarding.
    const store = new InMemoryStore();
    const hub = await startedHub(store);

    const daemonADevice = await store.createDevice({ userId: 'user-a', type: 'daemon', name: 'a-laptop', tokenHash: 'hash-a' });
    const daemonA = fakeConnection({ deviceId: daemonADevice.id, deviceType: 'daemon', userId: 'user-a' });
    hub.register(daemonA);
    const browserA = fakeConnection({ deviceId: 'browser-a', deviceType: 'browser', userId: 'user-a' });
    hub.register(browserA);

    const daemonBDevice = await store.createDevice({ userId: 'user-b', type: 'daemon', name: 'b-laptop', tokenHash: 'hash-b' });
    const daemonB = fakeConnection({ deviceId: daemonBDevice.id, deviceType: 'daemon', userId: 'user-b' });
    hub.register(daemonB);
    const browserB = fakeConnection({ deviceId: 'browser-b', deviceType: 'browser', userId: 'user-b' });
    hub.register(browserB);

    await hub.routeRpcRequest(browserB, 'req-b', 'ping', undefined);

    // B's request reached B's daemon and nothing reached A's.
    expect(daemonB.sent).toEqual([{ kind: 'rpc_request', requestId: 'req-b', method: 'ping', params: undefined }]);
    expect(daemonA.sent).toHaveLength(0);

    // And A's daemon cannot answer B's request even knowing its requestId.
    await hub.routeRpcResponse(daemonA, { requestId: 'req-b', result: { hijacked: true } });
    expect(browserB.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);

    // B's own daemon still can — proving the response path is live, so the assertion above
    // failed for the right reason rather than because responses were broken generally.
    await hub.routeRpcResponse(daemonB, { requestId: 'req-b', result: { ok: true } });
    expect(browserB.sent).toEqual([{ kind: 'rpc_response', requestId: 'req-b', result: { ok: true }, error: undefined }]);
    expect(browserA.sent).toHaveLength(0);
  });

  it('a colliding requestId from another user does not displace an in-flight entry', async () => {
    // pendingRpcRequests is namespaced by userId; a shared namespace would let this `set`
    // overwrite user-a's entry, and a's own response would then be dropped as unknown.
    const store = new InMemoryStore();
    const hub = await startedHub(store);

    const daemonADevice = await store.createDevice({ userId: 'user-a', type: 'daemon', name: 'a-laptop', tokenHash: 'hash-a' });
    const daemonA = fakeConnection({ deviceId: daemonADevice.id, deviceType: 'daemon', userId: 'user-a' });
    hub.register(daemonA);
    const browserA = fakeConnection({ deviceId: 'browser-a', deviceType: 'browser', userId: 'user-a' });
    hub.register(browserA);

    const daemonBDevice = await store.createDevice({ userId: 'user-b', type: 'daemon', name: 'b-laptop', tokenHash: 'hash-b' });
    hub.register(fakeConnection({ deviceId: daemonBDevice.id, deviceType: 'daemon', userId: 'user-b' }));
    const browserB = fakeConnection({ deviceId: 'browser-b', deviceType: 'browser', userId: 'user-b' });
    hub.register(browserB);

    await hub.routeRpcRequest(browserA, 'same-id', 'ping', undefined);
    await hub.routeRpcRequest(browserB, 'same-id', 'ping', undefined);

    await hub.routeRpcResponse(daemonA, { requestId: 'same-id', result: { forA: true } });

    expect(browserA.sent).toEqual([{ kind: 'rpc_response', requestId: 'same-id', result: { forA: true }, error: undefined }]);
    expect(browserB.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);
  });

  it('a completed request frees its in-flight cap slot', async () => {
    // Without the delete in routeRpcResponse a device would be silently capped at
    // RPC_IN_FLIGHT_CAP_PER_DEVICE requests per TTL window for its whole lifetime, and every
    // other RPC test would still pass.
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    // Fill the cap, then settle every one of them.
    for (let i = 0; i < RPC_IN_FLIGHT_CAP_PER_DEVICE; i += 1) {
      await hub.routeRpcRequest(browser, `req-${i}`, 'ping', undefined);
    }
    for (let i = 0; i < RPC_IN_FLIGHT_CAP_PER_DEVICE; i += 1) {
      await hub.routeRpcResponse(daemon, { requestId: `req-${i}`, result: { ok: true } });
    }

    await hub.routeRpcRequest(browser, 'req-after', 'ping', undefined);

    // Forwarded to the daemon rather than rejected with in_flight_cap_exceeded.
    expect(daemon.sent.filter((m) => m.kind === 'rpc_request' && m.requestId === 'req-after')).toHaveLength(1);
    expect(browser.sent.filter((m) => m.kind === 'rpc_response' && m.error === 'in_flight_cap_exceeded')).toHaveLength(0);
  });

  it('unregistering a browser device\'s last connection purges its pending rpc entries and frees its cap budget', async () => {
    // The TTL sweep is lazy — it only runs from routeRpcRequest/routeRpcResponse — so on a relay
    // with no other RPC traffic nothing would ever collect these. Without the purge in
    // unregister they are pinned indefinitely rather than for PENDING_RPC_REQUEST_TTL_MS.
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    for (let i = 0; i < RPC_IN_FLIGHT_CAP_PER_DEVICE; i += 1) {
      await hub.routeRpcRequest(browser, `req-${i}`, 'ping', undefined);
    }
    hub.unregister(browser);

    // The same device reconnects and is not throttled by the orphans it left behind.
    const reconnected = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(reconnected);
    await hub.routeRpcRequest(reconnected, 'req-fresh', 'ping', undefined);

    expect(daemon.sent.filter((m) => m.kind === 'rpc_request' && m.requestId === 'req-fresh')).toHaveLength(1);
    expect(reconnected.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);

    // And the purged entries are truly gone: a late response for one finds nothing to route.
    await hub.routeRpcResponse(daemon, { requestId: 'req-0', result: { late: true } });
    expect(reconnected.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);
  });

  it('does not route an rpc_response for a requestId belonging to a different user back to that user\'s browser', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeRpcRequest(browser, 'req-1', 'ping', undefined);

    const intruderDaemon = fakeConnection({ deviceId: 'daemon-x', deviceType: 'daemon', userId: 'user-2' });
    await hub.routeRpcResponse(intruderDaemon, { requestId: 'req-1', result: { hijacked: true } });

    expect(browser.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);
  });

  it('returns a typed no_daemon error when the user has never paired a daemon', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeRpcRequest(browser, 'req-1', 'ping', undefined);

    expect(browser.sent).toEqual([{ kind: 'rpc_response', requestId: 'req-1', error: 'no_daemon' }]);
  });

  it('returns a typed daemon_disconnected error when the user has a paired daemon that is not currently connected', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeRpcRequest(browser, 'req-1', 'ping', undefined);

    expect(browser.sent).toEqual([{ kind: 'rpc_response', requestId: 'req-1', error: 'daemon_disconnected' }]);
  });

  it('rejects a new rpc_request with a typed error once a browser device has RPC_IN_FLIGHT_CAP_PER_DEVICE requests outstanding', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    for (let i = 0; i < 20; i++) {
      await hub.routeRpcRequest(browser, `req-${i}`, 'ping', undefined);
    }
    expect(daemon.sent).toHaveLength(20);

    await hub.routeRpcRequest(browser, 'req-overflow', 'ping', undefined);

    expect(daemon.sent).toHaveLength(20); // never forwarded to the daemon
    expect(browser.sent.filter((m) => m.kind === 'rpc_response')).toEqual([
      { kind: 'rpc_response', requestId: 'req-overflow', error: 'in_flight_cap_exceeded' },
    ]);
  });

  it('silently ignores an rpc_response for an unknown or already-routed requestId', async () => {
    const store = new InMemoryStore();
    const hub = await startedHub(store);
    const daemon = fakeConnection({ deviceId: 'daemon-1', deviceType: 'daemon', userId: 'user-1' });

    await expect(
      hub.routeRpcResponse(daemon, { requestId: 'does-not-exist', result: { ok: true } })
    ).resolves.toBeUndefined();
  });

  it('prunes an expired pendingRpcRequests entry so a very late rpc_response is not routed', async () => {
    const store = new InMemoryStore();
    let now = 1000;
    const hub = new ConnectionHub(store, new InMemoryPubSub(), undefined, () => now);
    await hub.start();
    const daemonDevice = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-1' });
    const daemon = fakeConnection({ deviceId: daemonDevice.id, deviceType: 'daemon', userId: 'user-1' });
    hub.register(daemon);
    const browser = fakeConnection({ deviceId: 'browser-1', deviceType: 'browser', userId: 'user-1' });
    hub.register(browser);

    await hub.routeRpcRequest(browser, 'req-1', 'ping', undefined);

    now += 30_001; // past PENDING_RPC_REQUEST_TTL_MS
    await hub.routeRpcResponse(daemon, { requestId: 'req-1', result: { ok: true } });

    expect(browser.sent.filter((m) => m.kind === 'rpc_response')).toHaveLength(0);
  });
});
