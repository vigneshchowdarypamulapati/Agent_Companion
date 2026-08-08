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
  const factory = (options: RelayConnectionOptions) => {
    capturedOptions = options;
    connect.mockImplementation(() => options.onOpen?.());
    close.mockImplementation(() => options.onClose?.());
    return {
      connect,
      close,
      sendCommand: vi.fn((sessionId: string, command: Command) => sentCommands.push({ sessionId, command })),
    };
  };
  return { factory, sentCommands, connect, close, getOptions: () => capturedOptions! };
}

describe('useRelayConnection', () => {
  it('connects on mount and reports connected once onOpen fires', async () => {
    const fake = createFakeConnection();
    const { result } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    await waitFor(() => expect(result.current.connected).toBe(true));
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
      result.current.sendCommand('sess-1', { type: 'pause', sessionId: 'sess-1' });
    });

    expect(fake.sentCommands).toEqual([{ sessionId: 'sess-1', command: { type: 'pause', sessionId: 'sess-1' } }]);
  });

  it('closes the connection on unmount', () => {
    const fake = createFakeConnection();
    const { unmount } = renderHook(() =>
      useRelayConnection({ url: 'ws://x', token: 't', onEvent: () => {}, createConnection: fake.factory })
    );

    unmount();
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
