import { describe, it, expect } from 'vitest';
import { RelayMessage, RedeemPairingRequest } from './relay.js';

describe('RelayMessage schema', () => {
  it('accepts a valid event envelope', () => {
    const result = RelayMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      seq: 1,
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an event envelope missing seq', () => {
    const result = RelayMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid command envelope', () => {
    const result = RelayMessage.safeParse({
      kind: 'command',
      sessionId: 'sess-1',
      command: { type: 'pause', sessionId: 'sess-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope with an invalid kind', () => {
    const result = RelayMessage.safeParse({ kind: 'nope', sessionId: 'sess-1' });
    expect(result.success).toBe(false);
  });
});

describe('RedeemPairingRequest schema', () => {
  it('accepts a valid redeem request', () => {
    const result = RedeemPairingRequest.safeParse({
      code: '123456',
      deviceType: 'daemon',
      deviceName: 'my-laptop',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid deviceType', () => {
    const result = RedeemPairingRequest.safeParse({
      code: '123456',
      deviceType: 'toaster',
      deviceName: 'my-laptop',
    });
    expect(result.success).toBe(false);
  });
});
