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
    });
    await store.updateSessionStatus('sess-1', 'paused');

    const session = await store.getSession('sess-1');
    expect(session?.status).toBe('paused');
  });

  it('getActiveSessionForUser returns the session that is not stopped', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
    });

    const active = await store.getActiveSessionForUser('user-1');
    expect(active?.id).toBe('sess-1');
  });

  it('getActiveSessionForUser returns undefined once the session is stopped', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
    });
    await store.updateSessionStatus('sess-1', 'stopped');

    expect(await store.getActiveSessionForUser('user-1')).toBeUndefined();
  });

  it('getActiveSessionForUser only returns sessions belonging to that user', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-1',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/project',
      status: 'running',
      startedAt: 1,
    });

    expect(await store.getActiveSessionForUser('user-2')).toBeUndefined();
  });

  it('getActiveSessionForUser returns the most recently started non-stopped session', async () => {
    const store = new InMemoryStore();
    // Inserted first, started later: a stale non-stopped session (e.g. a
    // daemon that died without emitting `stopped`) must not win on insertion
    // order alone.
    await store.upsertSession({
      id: 'sess-old',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/old',
      status: 'running',
      startedAt: 100,
    });
    await store.upsertSession({
      id: 'sess-new',
      userId: 'user-1',
      daemonDeviceId: 'device-2',
      projectPath: '/tmp/new',
      status: 'running',
      startedAt: 200,
    });

    expect((await store.getActiveSessionForUser('user-1'))?.id).toBe('sess-new');
  });

  it('getActiveSessionForUser prefers the greater startedAt even when it was created first', async () => {
    const store = new InMemoryStore();
    await store.upsertSession({
      id: 'sess-new',
      userId: 'user-1',
      daemonDeviceId: 'device-2',
      projectPath: '/tmp/new',
      status: 'running',
      startedAt: 200,
    });
    await store.upsertSession({
      id: 'sess-old',
      userId: 'user-1',
      daemonDeviceId: 'device-1',
      projectPath: '/tmp/old',
      status: 'running',
      startedAt: 100,
    });

    expect((await store.getActiveSessionForUser('user-1'))?.id).toBe('sess-new');
  });
});
