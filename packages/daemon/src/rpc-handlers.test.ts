import { describe, it, expect } from 'vitest';
import { dispatchRpc, type RpcHandler } from './rpc-handlers.js';

describe('dispatchRpc', () => {
  it('ping returns the daemon version and uptime computed from startedAt', async () => {
    const outcome = await dispatchRpc('ping', undefined, {
      version: '1.2.3',
      startedAt: 1000,
      now: () => 1500,
    });
    expect(outcome).toEqual({ result: { version: '1.2.3', uptimeMs: 500 } });
  });

  it('returns a typed unknown_method error for a method with no registered handler', async () => {
    const outcome = await dispatchRpc('does-not-exist', undefined, { version: '1.2.3', startedAt: 0 });
    expect(outcome).toEqual({ error: 'unknown_method' });
  });

  it('returns a typed handler_error result instead of throwing when a handler throws', async () => {
    const throwingRegistry: Record<string, RpcHandler> = {
      broken: () => {
        throw new Error('boom');
      },
    };
    const outcome = await dispatchRpc('broken', undefined, { version: '1.2.3', startedAt: 0 }, throwingRegistry);
    expect(outcome).toEqual({ error: 'handler_error' });
  });

  it('returns a typed handler_error result when an async handler rejects', async () => {
    const rejectingRegistry: Record<string, RpcHandler> = {
      broken: async () => {
        throw new Error('boom');
      },
    };
    const outcome = await dispatchRpc('broken', undefined, { version: '1.2.3', startedAt: 0 }, rejectingRegistry);
    expect(outcome).toEqual({ error: 'handler_error' });
  });
});
