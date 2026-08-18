import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRelayConnection } from './use-relay-connection';
import type { Command, SessionEvent } from '@companion/protocol';
import type { RelayConnectionOptions } from './relay-connection';

function createFakeConnection() {
  let capturedOptions: RelayConnectionOptions | undefined;
  const sentCommands: { sessionId: string; command: Command }[] = [];
  const close = vi.fn();
  const connect = vi.fn();
  const checkLiveness = vi.fn();
  const callDaemon = vi.fn().mockResolvedValue(undefined);
  let nextCommandId = 0;
  const factory = (options: RelayConnectionOptions) => {
    capturedOptions = options;
    connect.mockImplementation(() => options.onOpen?.());
    close.mockImplementation(() => options.onClose?.());
    return {
      connect,
      close,
      checkLiveness,
      callDaemon,
      sendCommand: vi.fn((sessionId: string, command: Command) => {
        sentCommands.push({ sessionId, command });
        nextCommandId += 1;
        return `cmd-${nextCommandId}`;
      }),
    };
  };
  return { factory, sentCommands, connect, close, checkLiveness, callDaemon, getOptions: () => capturedOptions! };
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

describe('useRelayConnection', () => {
  it('connects on mount and reports "live" once onOpen fires', async () => {
    const fake = createFakeConnection();
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    await waitFor(() => expect(result.current.connectionState).toBe('live'));
  });

  it('reports "connecting" before the first open, and "reconnecting" after a drop that followed a successful open', () => {
    let capturedOptions: RelayConnectionOptions | undefined;
    const factory = (options: RelayConnectionOptions) => {
      capturedOptions = options;
      return { connect: vi.fn(), close: vi.fn(), checkLiveness: vi.fn(), sendCommand: vi.fn(), callDaemon: vi.fn() };
    };
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: factory })
    );
    expect(result.current.connectionState).toBe('connecting');

    act(() => {
      capturedOptions!.onOpen?.();
    });
    expect(result.current.connectionState).toBe('live');

    act(() => {
      capturedOptions!.onClose?.();
    });
    expect(result.current.connectionState).toBe('reconnecting');
  });

  it('reports "offline" regardless of socket state once navigator.onLine goes false, and recovers on "online"', () => {
    const fake = createFakeConnection();
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );
    expect(result.current.connectionState).toBe('live');

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.connectionState).toBe('offline');

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current.connectionState).toBe('live');
  });

  it('calls checkLiveness on the connection when the tab becomes visible, but not when it becomes hidden', () => {
    const fake = createFakeConnection();
    renderHook(() => useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory }));
    fake.checkLiveness.mockClear();

    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fake.checkLiveness).not.toHaveBeenCalled();

    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fake.checkLiveness).toHaveBeenCalledOnce();
  });

  it('calls checkLiveness on the connection when the device regains connectivity', () => {
    const fake = createFakeConnection();
    renderHook(() => useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory }));
    fake.checkLiveness.mockClear();

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(fake.checkLiveness).toHaveBeenCalledOnce();
  });

  it('forwards received events to the onEvent callback', () => {
    const fake = createFakeConnection();
    const events: SessionEvent[] = [];
    renderHook(() =>
      useRelayConnection({
        url: 'ws://x',
        token: 't',
        onEvent: (message) => events.push(message.event),
        createConnection: fake.factory,
      })
    );

    const event: SessionEvent = { type: 'turn_complete', sessionId: 'sess-1', at: 1 };
    act(() => {
      fake.getOptions().onEvent({ sessionId: 'sess-1', seq: 1, event });
    });

    expect(events).toEqual([event]);
  });

  it('sendCommand delegates to the underlying connection', () => {
    const fake = createFakeConnection();
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    act(() => {
      void result.current.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' });
    });

    expect(fake.sentCommands).toEqual([{ sessionId: 'sess-1', command: { type: 'pause', sessionId: 'sess-1' } }]);
  });

  it("sendCommand's promise resolves with the ack once the connection's onCommandAck fires for that commandId", async () => {
    const fake = createFakeConnection();
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    let ackResult: unknown;
    act(() => {
      void result.current.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' }).then((r) => {
        ackResult = r;
      });
    });

    act(() => {
      fake.getOptions().onCommandAck?.('cmd-1', { status: 'delivered' });
    });

    await waitFor(() => expect(ackResult).toEqual({ status: 'delivered' }));
  });

  it("sendCommand's promise resolves failed without a connection (called before mount effect runs, or after unmount)", async () => {
    const fake = createFakeConnection();
    const { result, unmount } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );
    unmount();

    const ackResult = await result.current.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' });
    expect(ackResult.status).toBe('failed');
    expect(fake.sentCommands).toEqual([]);
  });

  it('callDaemon delegates to the underlying connection and resolves with its result', async () => {
    const fake = createFakeConnection();
    fake.callDaemon.mockResolvedValue({ version: '1.0.0', uptimeMs: 5 });
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    const promise = result.current.callDaemon('ping', { foo: 'bar' });

    expect(fake.callDaemon).toHaveBeenCalledWith('ping', { foo: 'bar' });
    await expect(promise).resolves.toEqual({ version: '1.0.0', uptimeMs: 5 });
  });

  it('callDaemon rejects with a typed NOT_CONNECTED RpcError without a connection (called before mount effect runs, or after unmount)', async () => {
    const fake = createFakeConnection();
    const { result, unmount } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );
    unmount();

    await expect(result.current.callDaemon('ping')).rejects.toMatchObject({ name: 'RpcError', code: 'not_connected' });
    expect(fake.callDaemon).not.toHaveBeenCalled();
  });

  it('passes onLog through to the connection options', () => {
    const fake = createFakeConnection();
    const logs: string[] = [];
    renderHook(() =>
      useRelayConnection({
        url: 'ws://x',
        token: 't',
        onEvent: () => {},
        onLog: (message) => logs.push(message),
        createConnection: fake.factory,
      })
    );

    act(() => {
      fake.getOptions().onLog?.('Connected to relay');
    });

    expect(logs).toEqual(['Connected to relay']);
  });

  it('closes the connection on unmount', () => {
    const fake = createFakeConnection();
    const { unmount } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    unmount();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('passes onUnauthorized through to the connection options', () => {
    const fake = createFakeConnection();
    const calls: number[] = [];
    renderHook(() =>
      useRelayConnection({
        url: 'ws://x',
        token: 't',
        onEvent: () => {},
        onUnauthorized: () => calls.push(1),
        createConnection: fake.factory,
      })
    );

    act(() => {
      fake.getOptions().onUnauthorized?.();
    });

    expect(calls).toEqual([1]);
  });
});
