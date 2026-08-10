import { describe, it, expect } from 'vitest';
import { InMemoryStore } from './in-memory-store.js';

describe('InMemoryStore', () => {
  it('returns the same default user on repeated calls', async () => {
    const store = new InMemoryStore();
    const first = await store.getOrCreateDefaultUser();
    const second = await store.getOrCreateDefaultUser();
    expect(second.id).toBe(first.id);
  });

  it('creates a device and finds it by token hash', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const device = await store.createDevice({
      userId: user.id,
      type: 'daemon',
      name: 'laptop',
      tokenHash: 'hash-1',
    });
    const found = await store.getDeviceByTokenHash('hash-1');
    expect(found?.id).toBe(device.id);
  });

  it('returns undefined for an unknown token hash', async () => {
    const store = new InMemoryStore();
    expect(await store.getDeviceByTokenHash('does-not-exist')).toBeUndefined();
  });

  it('deleteDevice removes the device so its token no longer authenticates', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const device = await store.createDevice({
      userId: user.id,
      type: 'browser',
      name: 'phone',
      tokenHash: 'hash-2',
    });

    await store.deleteDevice(device.id);

    expect(await store.getDeviceByTokenHash('hash-2')).toBeUndefined();
  });

  it('deleteDevice is a no-op for an unknown device id', async () => {
    const store = new InMemoryStore();
    await expect(store.deleteDevice('does-not-exist')).resolves.toBeUndefined();
  });

  it('a pairing code can only be consumed once', async () => {
    const store = new InMemoryStore();
    const user = await store.getOrCreateDefaultUser();
    const pairing = await store.createPairingCode(user.id);

    const first = await store.consumePairingCode(pairing.code);
    expect(first?.code).toBe(pairing.code);

    const second = await store.consumePairingCode(pairing.code);
    expect(second).toBeUndefined();
  });

  it('consumePairingCode returns undefined for an expired code', async () => {
    let now = 1_000_000;
    const store = new InMemoryStore(() => now);
    const user = await store.getOrCreateDefaultUser();
    const pairing = await store.createPairingCode(user.id);

    now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute TTL

    expect(await store.consumePairingCode(pairing.code)).toBeUndefined();
  });

  it('appends and retrieves session events in order, filtered by sinceSeq', async () => {
    const store = new InMemoryStore();
    await store.appendSessionEvent('sess-1', {
      type: 'turn_complete',
      sessionId: 'sess-1',
      at: 1,
    });
    const second = await store.appendSessionEvent('sess-1', {
      type: 'turn_complete',
      sessionId: 'sess-1',
      at: 2,
    });

    const all = await store.getSessionEvents('sess-1');
    expect(all).toHaveLength(2);

    const sinceFirst = await store.getSessionEvents('sess-1', all[0].seq);
    expect(sinceFirst).toHaveLength(1);
    expect(sinceFirst[0].seq).toBe(second.seq);
  });

  it('upsertSession and updateSessionStatus round-trip', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });
    await store.updateSessionStatus('sess-1', 'paused');

    const session = await store.getSession('sess-1');
    expect(session?.status).toBe('paused');
  });

  it("appendSessionEvent bumps the owning session's lastEventAt", async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 42 });

    expect((await store.getSession('sess-1'))?.lastEventAt).toBe(42);
  });

  it('getActiveSessionsForUser returns every non-dismissed session for that user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project-a',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });
    await store.upsertSession({
      id: 'sess-2',
      userId: 'user-1',
      daemonDeviceId: 'device-2',
      projectPath: '/tmp/project-b',
      status: 'waiting_permission',
      startedAt: 2,
      lastEventAt: 2,
      dismissed: false,
    });

    const active = await store.getActiveSessionsForUser('user-1');
    expect(active.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('getActiveSessionsForUser includes a stopped session until it is dismissed', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'stopped',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect((await store.getActiveSessionsForUser('user-1')).map((s) => s.id)).toEqual(['sess-1']);

    await store.dismissSession('sess-1', 'user-1');

    expect(await store.getActiveSessionsForUser('user-1')).toEqual([]);
  });

  it('getActiveSessionsForUser only returns sessions belonging to that user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.getActiveSessionsForUser('user-2')).toEqual([]);
  });

  it('dismissSession returns not_found for an unknown session', async () => {
    const store = new InMemoryStore();
    expect(await store.dismissSession('does-not-exist', 'user-1')).toBe('not_found');
  });

  it('dismissSession returns forbidden for a session owned by another user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'stopped',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.dismissSession('sess-1', 'user-2')).toBe('forbidden');
  });

  it('dismissSession returns not_stopped for a session that is still running', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.dismissSession('sess-1', 'user-1')).toBe('not_stopped');
    expect((await store.getSession('sess-1'))?.dismissed).toBe(false);
  });

  it('dismissSession marks a stopped session dismissed and returns ok', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'stopped',
      startedAt: 1,
      lastEventAt: 1,
      dismissed: false,
    });

    expect(await store.dismissSession('sess-1', 'user-1')).toBe('ok');
    expect((await store.getSession('sess-1'))?.dismissed).toBe(true);
  });
});
