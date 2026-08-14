import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import SessionDetail from './SessionDetail';
import * as sessionsApi from './api/sessions';
import { UnauthorizedError } from './api/sessions';
import * as sessionsProviderModule from './SessionsProvider';
import type { LiveEvent } from './use-relay-connection';
import type { SessionSummary } from './use-sessions-store';

const activeSummary: SessionSummary = {
  id: 'sess-1',
  projectPath: '/tmp/project',
  status: 'running',
  lastEventAt: 1,
};

function mockSessions(overrides: Partial<ReturnType<typeof sessionsProviderModule.useSessions>> = {}) {
  const handlers = new Map<string, (message: LiveEvent) => void>();
  const sendCommand = vi.fn();
  const subscribe = vi.fn((sessionId: string, handler: (message: LiveEvent) => void) => {
    handlers.set(sessionId, handler);
    return () => handlers.delete(sessionId);
  });
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [activeSummary],
    loaded: true,
    connected: true,
    loadError: undefined,
    dismissSession: vi.fn(),
    sendCommand,
    subscribe,
    ...overrides,
  });
  return {
    sendCommand,
    emit: (message: LiveEvent) => handlers.get(message.sessionId)?.(message),
  };
}

function renderDetail(props: { token?: string; onUnauthorized?: () => void; path?: string } = {}) {
  const { token = 'tok-1', onUnauthorized = () => {}, path = '/sessions/sess-1' } = props;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sessions/:id" element={<SessionDetail token={token} onUnauthorized={onUnauthorized} />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('SessionDetail', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and renders the session history on mount', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 1 },
        createdAt: 1,
      },
    ]);
    mockSessions();

    renderDetail();

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
  });

  it('shows the last-assistant-message callout and contextual placeholder when waiting_input', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'Task 1 is done — want task 2 next?', at: 1 },
        createdAt: 1,
      },
      {
        seq: 2,
        sessionId: 'sess-1',
        event: { type: 'turn_complete', sessionId: 'sess-1', at: 2 },
        createdAt: 2,
      },
    ]);
    mockSessions({ sessions: [{ ...activeSummary, status: 'waiting_input' }] });

    renderDetail();

    expect(await screen.findByText('Claude is waiting for your reply')).toBeInTheDocument();
    expect(screen.getByText('Task 1 is done — want task 2 next?', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("What's next?")).toBeInTheDocument();
  });

  it('does not show the callout when the current turn produced no assistant_text, even if an earlier turn did', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'first message', at: 1 },
        createdAt: 1,
      },
      {
        seq: 2,
        sessionId: 'sess-1',
        event: { type: 'turn_complete', sessionId: 'sess-1', at: 2 },
        createdAt: 2,
      },
      {
        seq: 3,
        sessionId: 'sess-1',
        event: { type: 'turn_complete', sessionId: 'sess-1', at: 3 },
        createdAt: 3,
      },
    ]);
    mockSessions({ sessions: [{ ...activeSummary, status: 'waiting_input' }] });

    renderDetail();

    await screen.findByPlaceholderText("What's next?");
    expect(screen.queryByText('Claude is waiting for your reply')).not.toBeInTheDocument();
    expect(screen.queryByText('first message', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('does not show the waiting_input callout when running', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([
      {
        seq: 1,
        sessionId: 'sess-1',
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'still working', at: 1 },
        createdAt: 1,
      },
    ]);
    mockSessions();

    renderDetail();

    await screen.findByText('Running');
    expect(screen.queryByText('Claude is waiting for your reply')).not.toBeInTheDocument();
  });

  it('appends a live event received through subscribe', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockSessions();

    renderDetail();
    await screen.findByText('Running');

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 2,
        event: { type: 'assistant_text', sessionId: 'sess-1', text: 'live update', at: 2 },
      });
    });

    expect(await screen.findByText('live update')).toBeInTheDocument();
  });

  it('shows a PermissionPrompt for a pending request and sends the response', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockSessions();

    renderDetail();
    await screen.findByText('Running');

    act(() => {
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
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    const mock = mockSessions();

    renderDetail();
    await screen.findByText('Running');

    act(() => {
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
    });
    await screen.findByRole('button', { name: /approve/i });

    act(() => {
      mock.emit({
        sessionId: 'sess-1',
        seq: 3,
        event: { type: 'permission_resolved', sessionId: 'sess-1', requestId: 'req-1', approved: true, at: 3 },
      });
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument());
  });

  it('calls onUnauthorized when the history fetch is rejected with 401', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockRejectedValue(new UnauthorizedError());
    mockSessions();
    const onUnauthorized = vi.fn();

    renderDetail({ onUnauthorized });

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
  });

  it('shows a distinct error state when the history load fails', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockRejectedValue(
      new Error('Failed to fetch session events: HTTP 500')
    );
    mockSessions();

    renderDetail();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to fetch session events: HTTP 500');
  });

  it('re-fetches events since the last-seen seq after reconnecting', async () => {
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

    function tree(connected: boolean) {
      vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
        sessions: [activeSummary],
        loaded: true,
        connected,
        loadError: undefined,
        dismissSession: vi.fn(),
        sendCommand: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      });
      return (
        <MemoryRouter initialEntries={['/sessions/sess-1']}>
          <Routes>
            <Route path="/sessions/:id" element={<SessionDetail token="tok-1" onUnauthorized={() => {}} />} />
          </Routes>
        </MemoryRouter>
      );
    }

    const { rerender } = render(tree(true));
    await screen.findByText('Running');

    rerender(tree(false));
    rerender(tree(true));

    expect(await screen.findByText('missed while offline')).toBeInTheDocument();
  });

  it('shows "Session not found" when the id is not in the shared sessions list', async () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    mockSessions({ sessions: [] });

    renderDetail();

    expect(await screen.findByText('Session not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sessions/i })).toHaveAttribute('href', '/');
  });

  it('shows a loading state while the shared session list has not loaded yet', () => {
    vi.spyOn(sessionsApi, 'getSessionEvents').mockResolvedValue([]);
    mockSessions({ loaded: false, sessions: [] });

    renderDetail();

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
