import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSessionsStore } from './use-sessions-store';
import * as sessionsApi from './api/sessions';
import { UnauthorizedError } from './api/sessions';
import * as useRelayConnectionModule from './use-relay-connection';
import type { LiveEvent } from './use-relay-connection';

function mockUseRelayConnection() {
  let capturedOnEvent: ((message: LiveEvent) => void) | undefined;
  let capturedOnUnauthorized: (() => void) | undefined;
  let connectedValue = true;
  const sendCommand = vi.fn();
  vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockImplementation((options) => {
    capturedOnEvent = options.onEvent;
    capturedOnUnauthorized = options.onUnauthorized;
    return { connected: connectedValue, sendCommand };
  });
  return {
    emit: (message: LiveEvent) => capturedOnEvent?.(message),
    emitUnauthorized: () => capturedOnUnauthorized?.(),
    sendCommand,
    setConnected: (value: boolean) => {
      connectedValue = value;
    },
  };
}

const sessionA: sessionsApi.SessionRecord = {
  id: 'sess-1',
  userId: 'u',
  daemonDeviceId: 'd',
  projectPath: '/tmp/a',
  status: 'running',
  startedAt: 1,
  lastEventAt: 1,
};
const sessionB: sessionsApi.SessionRecord = {
  id: 'sess-2',
  userId: 'u',
  daemonDeviceId: 'd',
  projectPath: '/tmp/b',
  status: 'running',
  startedAt: 2,
  lastEventAt: 2,
};

describe('useSessionsStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the active sessions on mount', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA, sessionB]);
    mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.sessions.map((s) => s.id).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it("updates an existing session's status and lastEventAt from a live event", async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: {
          type: 'permission_request',
          sessionId: 'sess-1',
          requestId: 'r1',
          toolName: 'Bash',
          input: {},
          at: 5,
        },
      });
    });

    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === 'sess-1')).toMatchObject({
        status: 'waiting_permission',
        lastEventAt: 5,
      })
    );
  });

  it('sets status to waiting_input on a live turn_complete event, and back to running on assistant_text', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      mock.emit({ sessionId: 'sess-1', seq: 2, event: { type: 'turn_complete', sessionId: 'sess-1', at: 5 } });
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === 'sess-1')).toMatchObject({ status: 'waiting_input' })
    );

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 3,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'continuing…', at: 6 },
      });
    });
    await waitFor(() =>
      expect(result.current.sessions.find((s) => s.id === 'sess-1')).toMatchObject({ status: 'running' })
    );
  });

  it('inserts a new session on a live session_started event', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => {
      mock.emit({
        sessionId: 'sess-new',
        seq: 1,
        event: { type: 'session_started', sessionId: 'sess-new', projectPath: '/tmp/new', at: 9 },
      });
    });

    await waitFor(() =>
      expect(result.current.sessions).toContainEqual({
        id: 'sess-new',
        projectPath: '/tmp/new',
        status: 'running',
        lastEventAt: 9,
      })
    );
  });

  it('buffers a live event that arrives before the initial load resolves, then applies it once', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord[]) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord[]>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockReturnValue(activePromise);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 1,
        event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/a', at: 1 },
      });
    });

    await act(async () => {
      resolveActive([]);
      await activePromise;
    });

    expect(result.current.sessions).toEqual([
      { id: 'sess-1', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 },
    ]);
  });

  it('notifies a per-session subscriber exactly once for a buffered event', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord[]) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord[]>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockReturnValue(activePromise);
    const mock = mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    const received: LiveEvent[] = [];
    act(() => {
      result.current.subscribe('sess-1', (message) => received.push(message));
    });

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 1,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 1 },
      });
    });

    await act(async () => {
      resolveActive([]);
      await activePromise;
    });

    expect(received).toHaveLength(1);
  });

  it('re-runs discovery when reconnecting after having connected before', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValueOnce([]).mockResolvedValueOnce([sessionA]);
    const mock = mockUseRelayConnection();

    const { result, rerender } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.sessions).toEqual([]);

    mock.setConnected(false);
    rerender();
    mock.setConnected(true);
    rerender();

    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual(['sess-1']));
  });

  it('calls onUnauthorized when the initial load is rejected with 401', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockRejectedValue(new UnauthorizedError());
    mockUseRelayConnection();
    const onUnauthorized = vi.fn();

    renderHook(() => useSessionsStore('bad-token', onUnauthorized));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it('calls onUnauthorized when the relay connection reports the token was rejected', () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    const relay = mockUseRelayConnection();
    const onUnauthorized = vi.fn();

    renderHook(() => useSessionsStore('tok-1', onUnauthorized));

    act(() => {
      relay.emitUnauthorized();
    });

    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('dismissSession removes the session from state on success', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    vi.spyOn(sessionsApi, 'dismissSession').mockResolvedValue(undefined);
    mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await act(async () => {
      await result.current.dismissSession('sess-1');
    });

    expect(result.current.sessions).toEqual([]);
  });

  it('dismissSession re-throws a non-401 error and leaves state unchanged', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([sessionA]);
    vi.spyOn(sessionsApi, 'dismissSession').mockRejectedValue(new Error('Session is not stopped yet'));
    mockUseRelayConnection();

    const { result } = renderHook(() => useSessionsStore('tok-1', () => {}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));

    await expect(result.current.dismissSession('sess-1')).rejects.toThrow('not stopped');
    expect(result.current.sessions).toHaveLength(1);
  });
});
