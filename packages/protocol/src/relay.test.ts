import { describe, it, expect } from 'vitest';
import {
  DaemonToRelayMessage,
  RelayToDaemonMessage,
  BrowserToRelayMessage,
  RelayToBrowserMessage,
  RpcResponseMessage,
  RequestPairingCodeRequest,
  ClaimPairingRequest,
  PollPairingRequest,
  RegisterBrowserRequest,
} from './relay.js';

describe('DaemonToRelayMessage schema', () => {
  it('accepts a valid event envelope with a deliverySeq', () => {
    const result = DaemonToRelayMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      deliverySeq: 1,
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an event envelope missing deliverySeq', () => {
    const result = DaemonToRelayMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event envelope carrying a relay-owned seq instead of deliverySeq', () => {
    // The whole point of splitting the union: the daemon no longer has a `seq` field to fill in.
    const result = DaemonToRelayMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      seq: 1,
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid command_ack', () => {
    const result = DaemonToRelayMessage.safeParse({
      kind: 'command_ack',
      commandId: 'cmd-1',
      status: 'delivered',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid rpc_response with a result', () => {
    const result = DaemonToRelayMessage.safeParse({
      kind: 'rpc_response',
      requestId: 'req-1',
      result: { ok: true },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an rpc_response with both result and error', () => {
    const result = DaemonToRelayMessage.safeParse({
      kind: 'rpc_response',
      requestId: 'req-1',
      result: { ok: true },
      error: 'boom',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an rpc_response with neither result nor error', () => {
    const result = DaemonToRelayMessage.safeParse({
      kind: 'rpc_response',
      requestId: 'req-1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an envelope with an invalid kind', () => {
    const result = DaemonToRelayMessage.safeParse({ kind: 'nope', sessionId: 'sess-1' });
    expect(result.success).toBe(false);
  });
});

describe('RelayToDaemonMessage schema', () => {
  it('accepts a valid event_ack', () => {
    const result = RelayToDaemonMessage.safeParse({ kind: 'event_ack', deliverySeq: 5 });
    expect(result.success).toBe(true);
  });

  it('accepts a valid command envelope', () => {
    const result = RelayToDaemonMessage.safeParse({
      kind: 'command',
      sessionId: 'sess-1',
      command: { type: 'pause', sessionId: 'sess-1' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid rpc_request', () => {
    const result = RelayToDaemonMessage.safeParse({
      kind: 'rpc_request',
      requestId: 'req-1',
      method: 'some.method',
      params: { a: 1 },
    });
    expect(result.success).toBe(true);
  });
});

describe('BrowserToRelayMessage schema', () => {
  it('accepts a valid command envelope with a commandId', () => {
    const result = BrowserToRelayMessage.safeParse({
      kind: 'command',
      sessionId: 'sess-1',
      commandId: 'cmd-1',
      command: { type: 'pause', sessionId: 'sess-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a command envelope missing commandId', () => {
    const result = BrowserToRelayMessage.safeParse({
      kind: 'command',
      sessionId: 'sess-1',
      command: { type: 'pause', sessionId: 'sess-1' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid rpc_request', () => {
    const result = BrowserToRelayMessage.safeParse({
      kind: 'rpc_request',
      requestId: 'req-1',
      method: 'some.method',
      params: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('RelayToBrowserMessage schema', () => {
  it('accepts a valid event envelope with a store-assigned seq', () => {
    const result = RelayToBrowserMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      seq: 1,
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an event envelope missing seq', () => {
    const result = RelayToBrowserMessage.safeParse({
      kind: 'event',
      sessionId: 'sess-1',
      event: { type: 'turn_complete', sessionId: 'sess-1', at: Date.now() },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid command_ack', () => {
    const result = RelayToBrowserMessage.safeParse({
      kind: 'command_ack',
      commandId: 'cmd-1',
      status: 'failed',
      message: 'daemon offline',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an rpc_response with both result and error', () => {
    const result = RelayToBrowserMessage.safeParse({
      kind: 'rpc_response',
      requestId: 'req-1',
      result: 1,
      error: 'boom',
    });
    expect(result.success).toBe(false);
  });
});

describe('RpcResponseMessage schema (standalone)', () => {
  it('accepts exactly one of result/error', () => {
    expect(RpcResponseMessage.safeParse({ kind: 'rpc_response', requestId: 'r', result: 1 }).success).toBe(true);
    expect(RpcResponseMessage.safeParse({ kind: 'rpc_response', requestId: 'r', error: 'e' }).success).toBe(true);
  });

  it('rejects both or neither', () => {
    expect(RpcResponseMessage.safeParse({ kind: 'rpc_response', requestId: 'r' }).success).toBe(false);
    expect(
      RpcResponseMessage.safeParse({ kind: 'rpc_response', requestId: 'r', result: 1, error: 'e' }).success
    ).toBe(false);
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
    expect(ClaimPairingRequest.safeParse({ code: 'ABCD-1234' }).success).toBe(true);
  });

  it('rejects a missing code', () => {
    expect(ClaimPairingRequest.safeParse({}).success).toBe(false);
  });

  it('rejects an unreasonably long code', () => {
    expect(ClaimPairingRequest.safeParse({ code: 'A'.repeat(32) }).success).toBe(true);
    expect(ClaimPairingRequest.safeParse({ code: 'A'.repeat(33) }).success).toBe(false);
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
