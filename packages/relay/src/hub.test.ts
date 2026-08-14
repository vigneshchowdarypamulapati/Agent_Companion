import { describe, it, expect, vi } from 'vitest';
import { ConnectionHub, type Connection, type RelayHubMessage } from './hub.js';
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

  const subscriptionA = { endpoint: 'https://push.example.com/a', keys: { p256dh: 'p-a', auth: 'a-a' } };
  const subscriptionB = { endpoint: 'https://push.example.com/b', keys: { p256dh: 'p-b', auth: 'a-b' } };

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
});
