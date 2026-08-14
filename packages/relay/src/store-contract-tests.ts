import { describe, it, expect } from 'vitest';
import type { Store } from './store.js';

export function runStoreContractTests(label: string, makeStore: (now?: () => number) => Store | Promise<Store>): void {
  describe(label, () => {
    it('returns the same default user on repeated calls', async () => {
      const store = await makeStore();
      const first = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      const second = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      expect(second.id).toBe(first.id);
    });

    it('creates a device and finds it by token hash', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
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
      const store = await makeStore();
      expect(await store.getDeviceByTokenHash('does-not-exist')).toBeUndefined();
    });

    it('deleteDevice removes the device so its token no longer authenticates', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
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
      const store = await makeStore();
      await expect(store.deleteDevice('does-not-exist')).resolves.toBeUndefined();
    });

    it('setPushSubscription stores a subscription on the device', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      const device = await store.createDevice({
        userId: user.id,
        type: 'browser',
        name: 'phone',
        tokenHash: 'hash-3',
      });
      const subscription = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };

      await store.setPushSubscription(device.id, subscription);

      const devices = await store.getDevicesForUser(user.id);
      expect(devices.find((d) => d.id === device.id)?.pushSubscription).toEqual(subscription);
    });

    it('setPushSubscription with undefined clears an existing subscription', async () => {
      const store = await makeStore();
      const user = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      const device = await store.createDevice({
        userId: user.id,
        type: 'browser',
        name: 'phone',
        tokenHash: 'hash-4',
      });
      await store.setPushSubscription(device.id, {
        endpoint: 'https://push.example.com/abc',
        keys: { p256dh: 'p', auth: 'a' },
      });

      await store.setPushSubscription(device.id, undefined);

      const devices = await store.getDevicesForUser(user.id);
      expect(devices.find((d) => d.id === device.id)?.pushSubscription).toBeUndefined();
    });

    it('setPushSubscription is a no-op for an unknown device id', async () => {
      const store = await makeStore();
      await expect(
        store.setPushSubscription('does-not-exist', { endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } })
      ).resolves.toBeUndefined();
    });

    it('getDevicesForUser returns only devices belonging to that user', async () => {
      const store = await makeStore();
      await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-5' });
      await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-6' });
      await store.createDevice({ userId: 'user-2', type: 'browser', name: 'intruder', tokenHash: 'hash-7' });

      const devices = await store.getDevicesForUser('user-1');

      expect(devices.map((d) => d.name).sort()).toEqual(['laptop', 'phone']);
    });

    it('a pairing code can only be claimed once', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      const first = await store.claimPairingCode(pairing.code, 'user-1');
      expect(first).toBe('ok');

      const second = await store.claimPairingCode(pairing.code, 'user-2');
      expect(second).toBe('already_claimed');
    });

    it('claimPairingCode returns not_found for an unknown code', async () => {
      const store = await makeStore();
      expect(await store.claimPairingCode('000000', 'user-1')).toBe('not_found');
    });

    it('claimPairingCode returns expired for an expired code', async () => {
      let now = 1_000_000;
      const store = await makeStore(() => now);
      const pairing = await store.createPairingCode('my-laptop');

      now += 6 * 60 * 1000; // 6 minutes later, past the 5-minute TTL

      expect(await store.claimPairingCode(pairing.code, 'user-1')).toBe('expired');
    });

    it('getPairingCodeByDeviceCode finds the pairing code by its device code', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);

      expect(found?.code).toBe(pairing.code);
      expect(found?.userId).toBeNull();
      expect(found?.redeemed).toBe(false);
    });

    it('getPairingCodeByDeviceCode returns undefined for an unknown device code', async () => {
      const store = await makeStore();
      expect(await store.getPairingCodeByDeviceCode('does-not-exist')).toBeUndefined();
    });

    it('claiming a pairing code is reflected when looked up by device code', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      await store.claimPairingCode(pairing.code, 'user-1');

      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);
      expect(found?.userId).toBe('user-1');
    });

    it('redeemPairingCode sets redeemed to true and returns the claimed row', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');
      await store.claimPairingCode(pairing.code, 'user-1');

      const redeemed = await store.redeemPairingCode(pairing.deviceCode);

      expect(redeemed?.code).toBe(pairing.code);
      expect(redeemed?.userId).toBe('user-1');
      expect(redeemed?.deviceName).toBe('my-laptop');
      expect(redeemed?.redeemed).toBe(true);
      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);
      expect(found?.redeemed).toBe(true);
    });

    it('redeemPairingCode returns undefined for an unknown device code', async () => {
      const store = await makeStore();
      expect(await store.redeemPairingCode('does-not-exist')).toBeUndefined();
    });

    it('redeemPairingCode returns undefined for a code that has not been claimed yet', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');

      expect(await store.redeemPairingCode(pairing.deviceCode)).toBeUndefined();
      const found = await store.getPairingCodeByDeviceCode(pairing.deviceCode);
      expect(found?.redeemed).toBe(false);
    });

    it('redeemPairingCode returns undefined the second time — a code redeems exactly once', async () => {
      const store = await makeStore();
      const pairing = await store.createPairingCode('my-laptop');
      await store.claimPairingCode(pairing.code, 'user-1');

      expect(await store.redeemPairingCode(pairing.deviceCode)).toBeDefined();
      expect(await store.redeemPairingCode(pairing.deviceCode)).toBeUndefined();
    });

    it('getDaemonDeviceForUser returns the daemon device for that user', async () => {
      const store = await makeStore();
      await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-a' });
      const daemon = await store.createDevice({ userId: 'user-1', type: 'daemon', name: 'laptop', tokenHash: 'hash-b' });

      const found = await store.getDaemonDeviceForUser('user-1');

      expect(found?.id).toBe(daemon.id);
    });

    it('getDaemonDeviceForUser returns undefined when the user has no daemon device', async () => {
      const store = await makeStore();
      await store.createDevice({ userId: 'user-1', type: 'browser', name: 'phone', tokenHash: 'hash-a' });

      expect(await store.getDaemonDeviceForUser('user-1')).toBeUndefined();
    });

    it('getOrCreateUserByClerkId returns the same user on repeated calls with the same clerkUserId', async () => {
      const store = await makeStore();
      const first = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      const second = await store.getOrCreateUserByClerkId('clerk-user-1', 'you@example.com');
      expect(second.id).toBe(first.id);
    });

    it('getOrCreateUserByClerkId creates distinct users for distinct clerkUserIds', async () => {
      const store = await makeStore();
      const first = await store.getOrCreateUserByClerkId('clerk-user-1', 'a@example.com');
      const second = await store.getOrCreateUserByClerkId('clerk-user-2', 'b@example.com');
      expect(second.id).not.toBe(first.id);
    });

    it('appends and retrieves session events in order, filtered by sinceSeq', async () => {
      const store = await makeStore();
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

    it('getSessionEvents returns events in ascending seq order', async () => {
      const store = await makeStore();
      for (let i = 0; i < 10; i++) {
        await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: i });
      }
      const events = await store.getSessionEvents('sess-1');
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    });

    it('getSessionEvents returns an empty array for a NaN sinceSeq', async () => {
      const store = await makeStore();
      await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 1 });
      expect(await store.getSessionEvents('sess-1', NaN)).toEqual([]);
    });

    it('getLastEventOfType returns the most recently appended event of that type', async () => {
      const store = await makeStore();
      await store.appendSessionEvent('sess-1', { type: 'assistant_text', sessionId: 'sess-1', text: 'first', at: 1 });
      await store.appendSessionEvent('sess-1', { type: 'tool_use', sessionId: 'sess-1', toolName: 'Bash', input: {}, at: 2 });
      await store.appendSessionEvent('sess-1', { type: 'assistant_text', sessionId: 'sess-1', text: 'second', at: 3 });

      const found = await store.getLastEventOfType('sess-1', 'assistant_text');

      expect(found?.event).toMatchObject({ type: 'assistant_text', text: 'second' });
    });

    it('getLastEventOfType returns undefined when no event of that type exists', async () => {
      const store = await makeStore();
      await store.appendSessionEvent('sess-1', { type: 'turn_complete', sessionId: 'sess-1', at: 1 });

      expect(await store.getLastEventOfType('sess-1', 'assistant_text')).toBeUndefined();
    });

    it('getLastEventOfType returns undefined for an unknown session', async () => {
      const store = await makeStore();
      expect(await store.getLastEventOfType('does-not-exist', 'assistant_text')).toBeUndefined();
    });

    it('upsertSession and updateSessionStatus round-trip', async () => {
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
      expect(await store.dismissSession('does-not-exist', 'user-1')).toBe('not_found');
    });

    it('dismissSession returns forbidden for a session owned by another user', async () => {
      const store = await makeStore();
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
      const store = await makeStore();
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
      const store = await makeStore();
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
}
