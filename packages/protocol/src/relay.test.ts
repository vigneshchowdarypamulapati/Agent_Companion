import { describe, it, expect } from 'vitest';
import { RelayMessage, RequestPairingCodeRequest, ClaimPairingRequest, PollPairingRequest, RegisterBrowserRequest } from './relay.js';

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

describe('RequestPairingCodeRequest schema', () => {
  it('accepts a valid request', () => {
    expect(RequestPairingCodeRequest.safeParse({ deviceName: 'my-laptop' }).success).toBe(true);
  });

  it('rejects a missing deviceName', () => {
    expect(RequestPairingCodeRequest.safeParse({}).success).toBe(false);
  });
});

describe('ClaimPairingRequest schema', () => {
  it('accepts a valid request', () => {
    expect(ClaimPairingRequest.safeParse({ code: '123456' }).success).toBe(true);
  });

  it('rejects a missing code', () => {
    expect(ClaimPairingRequest.safeParse({}).success).toBe(false);
  });
});

describe('PollPairingRequest schema', () => {
  it('accepts a valid request', () => {
    expect(PollPairingRequest.safeParse({ deviceCode: 'abc' }).success).toBe(true);
  });

  it('rejects a missing deviceCode', () => {
    expect(PollPairingRequest.safeParse({}).success).toBe(false);
  });
});

describe('RegisterBrowserRequest schema', () => {
  it('accepts a valid request', () => {
    expect(RegisterBrowserRequest.safeParse({ deviceName: 'phone' }).success).toBe(true);
  });

  it('rejects a missing deviceName', () => {
    expect(RegisterBrowserRequest.safeParse({}).success).toBe(false);
  });
});
