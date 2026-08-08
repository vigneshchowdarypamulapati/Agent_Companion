import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dashboard from './Dashboard';
import * as sessionsApi from './api/sessions';
import { UnauthorizedError } from './api/sessions';
import * as useRelayConnectionModule from './use-relay-connection';
import type { LiveEvent } from './use-relay-connection';

function mockUseRelayConnection() {
  let capturedOnEvent: ((message: LiveEvent) => void) | undefined;
  let connectedValue = true;
  const sendCommand = vi.fn();
  vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockImplementation((options) => {
    capturedOnEvent = options.onEvent;
    return { connected: connectedValue, sendCommand };
  });
  return {
    emit: (message: LiveEvent) => capturedOnEvent?.(message),
    sendCommand,
    setConnected: (value: boolean) => {
      connectedValue = value;
    },
  };
}

const activeSession = {
  id: 'sess-1',
  userId: 'u',
  daemonDeviceId: 'd',
  projectPath: '/tmp/project',
  status: 'running' as const,
  startedAt: 1,
};

describe('Dashboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "No Active Sessions" when there is nothing active', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(undefined);
    mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    expect(await screen.findByText('No Active Sessions')).toBeInTheDocument();
  });

  it('loads the active session and its history on mount', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 1 },
        createdAt: 1,
      },
    ]);
    mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(await screen.findByText('hi')).toBeInTheDocument();
  });

  it('appends a live event to the activity feed', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('Running');

    mock.emit({
      sessionId: 'sess-1',
      seq: 2,
      event: { type: 'assistant_text', sessionId: 'sess-1', text: 'live update', at: 2 },
    });

    expect(await screen.findByText('live update')).toBeInTheDocument();
  });

  it('starts a fresh session and clears the feed on a live session_started event', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(undefined);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('No Active Sessions');

    mock.emit({
      sessionId: 'sess-2',
      seq: 1,
      event: { type: 'session_started', sessionId: 'sess-2', projectPath: '/new/project', at: 1 },
    });

    expect(await screen.findByText('/new/project')).toBeInTheDocument();
  });

  it('shows a PermissionPrompt for a pending request and sends the response', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('Running');

    mock.emit({
      sessionId: 'sess-1',
      seq: 2,
      event: {
        type: 'permission_request',
        sessionId: 'sess-1',
        requestId: 'req-1',
        toolName: 'Bash',
        input: {},
        at: 2,
      },
    });

    const approveButton = await screen.findByRole('button', { name: /approve/i });
    await userEvent.click(approveButton);

    expect(mock.sendCommand).toHaveBeenCalledWith('sess-1', {
      type: 'respond_to_permission',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    });
  });

  it('does not show a PermissionPrompt once the request has been resolved', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('Running');

    mock.emit({
      sessionId: 'sess-1',
      seq: 2,
      event: {
        type: 'permission_request',
        sessionId: 'sess-1',
        requestId: 'req-1',
        toolName: 'Bash',
        input: {},
        at: 2,
      },
    });
    await screen.findByRole('button', { name: /approve/i });

    mock.emit({
      sessionId: 'sess-1',
      seq: 3,
      event: { type: 'permission_resolved', sessionId: 'sess-1', requestId: 'req-1', approved: true, at: 3 },
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument());
  });

  it('calls onUnauthorized when the initial fetch is rejected with 401', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockRejectedValue(new UnauthorizedError());
    mockUseRelayConnection();
    const onUnauthorized = vi.fn();

    render(<Dashboard token="bad-token" onUnauthorized={onUnauthorized} />);

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it('re-fetches events since the last-seen seq after reconnecting', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          seq: 3,
          sessionId: 'sess-1',
          event: { type: 'assistant_text', sessionId: 'sess-1', text: 'missed while offline', at: 3 },
          createdAt: 3,
        },
      ]);
    const mock = mockUseRelayConnection();

    const { rerender } = render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('Running');

    mock.setConnected(false);
    rerender(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    mock.setConnected(true);
    rerender(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    expect(await screen.findByText('missed while offline')).toBeInTheDocument();
    expect(sessionsApi.getSessionEvents).toHaveBeenCalledWith('tok-1', 'sess-1', 0);
  });

  // Finding 1
  it('re-runs session discovery after reconnecting with no tracked session', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession')
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    const { rerender } = render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('No Active Sessions');

    mock.setConnected(false);
    rerender(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    mock.setConnected(true);
    rerender(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    // The session_started event that would have populated the view was missed
    // while the socket was down, so the reconnect must re-discover it.
    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
  });

  // Finding 2
  it('keeps a live event that arrives before the initial history load resolves', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord | undefined) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord | undefined>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSession').mockReturnValue(activePromise);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'from history', at: 1 },
        createdAt: 1,
      },
    ]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    // The socket is already delivering events while the two REST calls are
    // still in flight — this one must survive the history overwrite.
    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'live before load', at: 2 },
      });
    });

    await act(async () => {
      resolveActive(activeSession);
      await activePromise;
    });

    expect(await screen.findByText('live before load')).toBeInTheDocument();
    expect(screen.getByText('from history')).toBeInTheDocument();
  });

  // Finding 2 + Finding 5: buffered events are replayed through
  // handleLiveEvent, so the session-id filter applies to them too.
  it('drops a buffered event from a different session when the initial load resolves', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord | undefined) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord | undefined>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSession').mockReturnValue(activePromise);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'from history', at: 1 },
        createdAt: 1,
      },
    ]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    // seq is a single global counter across all of a user's sessions, so a
    // foreign event out-ranking the history snapshot is the common case.
    act(() => {
      mock.emit({
        sessionId: 'sess-other',
        seq: 2,
        event: { type: 'assistant_text', sessionId: 'sess-other', text: 'from another session', at: 2 },
      });
    });

    await act(async () => {
      resolveActive(activeSession);
      await activePromise;
    });

    expect(await screen.findByText('from history')).toBeInTheDocument();
    expect(screen.queryByText('from another session')).not.toBeInTheDocument();
  });

  // Finding 2 + status derivation
  it('applies status derivation to a buffered event when the initial load resolves', async () => {
    let resolveActive: (value: sessionsApi.SessionRecord | undefined) => void = () => {};
    const activePromise = new Promise<sessionsApi.SessionRecord | undefined>((resolve) => {
      resolveActive = resolve;
    });
    vi.spyOn(sessionsApi, 'getActiveSession').mockReturnValue(activePromise);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'from history', at: 1 },
        createdAt: 1,
      },
    ]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    act(() => {
      mock.emit({ sessionId: 'sess-1', seq: 2, event: { type: 'stopped', sessionId: 'sess-1', at: 2 } });
    });

    await act(async () => {
      resolveActive(activeSession);
      await activePromise;
    });

    // The REST snapshot said 'running'; the buffered stopped event must still
    // move the UI off it, or dead sessions show enabled controls.
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Session stopped')).toBeInTheDocument();
  });

  // Finding 3
  it('shows a distinct error state when the initial load fails', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockRejectedValue(
      new Error('Failed to fetch active session: HTTP 500')
    );
    mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to fetch active session: HTTP 500');
    expect(screen.queryByText('No Active Sessions')).not.toBeInTheDocument();
  });

  it('clears the load-error banner once a live event is processed', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockRejectedValue(
      new Error('Failed to fetch active session: HTTP 500')
    );
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByRole('alert');

    // Live traffic proves the relay connection is fine, whatever a past REST
    // call did.
    mock.emit({
      sessionId: 'sess-1',
      seq: 1,
      event: { type: 'session_started', sessionId: 'sess-1', projectPath: '/tmp/project', at: 1 },
    });

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
  });

  // Finding 5
  it('ignores live events belonging to a different session', async () => {
    vi.spyOn(sessionsApi, 'getActiveSession').mockResolvedValue(activeSession);
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockUseRelayConnection();

    render(<Dashboard token="tok-1" onUnauthorized={() => {}} />);
    await screen.findByText('Running');

    // The relay broadcasts every one of a user's events to every browser
    // connection, so a second paired daemon's session can show up here.
    mock.emit({
      sessionId: 'sess-other',
      seq: 2,
      event: { type: 'stopped', sessionId: 'sess-other', at: 2 },
    });
    mock.emit({
      sessionId: 'sess-1',
      seq: 3,
      event: { type: 'assistant_text', sessionId: 'sess-1', text: 'mine', at: 3 },
    });

    expect(await screen.findByText('mine')).toBeInTheDocument();
    expect(screen.queryByText('Session stopped')).not.toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });
});
