import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SessionList from './SessionList';
import * as sessionsProviderModule from './SessionsProvider';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';
import type { SessionSummary } from './use-sessions-store';

function mockSessions(overrides: Partial<ReturnType<typeof sessionsProviderModule.useSessions>> = {}) {
  const dismissSession = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [],
    loaded: true,
    connected: true,
    loadError: undefined,
    dismissSession,
    sendCommand: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  });
  return { dismissSession };
}

function renderList(token = 'tok-1', onUnauthorized = vi.fn()) {
  render(
    <MemoryRouter>
      <SessionList token={token} onUnauthorized={onUnauthorized} />
    </MemoryRouter>
  );
  return onUnauthorized;
}

describe('SessionList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the plain empty state when there are no active sessions and a daemon is already paired', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions();
    renderList();
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
    expect(screen.queryByText('Connect your daemon')).not.toBeInTheDocument();
  });

  it('shows daemon onboarding when there are no active sessions and no daemon is paired', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(false);
    mockSessions();
    renderList();
    expect(await screen.findByText('Connect your daemon')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions.')).not.toBeInTheDocument();
  });

  it('shows daemon onboarding if the daemon-status check itself fails', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockRejectedValue(new Error('HTTP 500'));
    mockSessions();
    renderList();
    expect(await screen.findByText('Connect your daemon')).toBeInTheDocument();
  });

  it('does not show onboarding or the empty-state text once real sessions exist', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(false);
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
    expect(screen.queryByText('Connect your daemon')).not.toBeInTheDocument();
    expect(screen.queryByText('No active sessions.')).not.toBeInTheDocument();
  });

  it('calls onUnauthorized if the daemon-status check gets a 401', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockRejectedValue(new UnauthorizedError());
    mockSessions();
    const onUnauthorized = renderList();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it('shows a loading state before the initial load resolves', () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions({ loaded: false });
    renderList();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('sorts a waiting_permission session ahead of a more recently active one', () => {
    const sessions: SessionSummary[] = [
      { id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 100 },
      { id: 'sess-b', projectPath: '/tmp/b', status: 'waiting_permission', lastEventAt: 1 },
    ];
    mockSessions({ sessions });
    renderList();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('/tmp/b');
    expect(items[1]).toHaveTextContent('/tmp/a');
  });

  it('shows the attention badge for a waiting_permission session', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'waiting_permission', lastEventAt: 1 }],
    });
    renderList();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('links each card to its session detail route', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    const cardLink = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/sessions/sess-a');
    expect(cardLink).toBeDefined();
  });

  it('links to the settings screen', () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions();
    renderList();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('shows a Dismiss button only for stopped sessions', () => {
    mockSessions({
      sessions: [
        { id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 },
        { id: 'sess-b', projectPath: '/tmp/b', status: 'running', lastEventAt: 2 },
      ],
    });
    renderList();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('calls dismissSession with the session id', async () => {
    const { dismissSession } = mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 }],
    });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dismissSession).toHaveBeenCalledWith('sess-a');
  });

  it('shows an inline error when dismiss fails, without removing the card', async () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 }],
      dismissSession: vi.fn().mockRejectedValue(new Error('Session is not stopped yet')),
    });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Session is not stopped yet');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('shows a banner when the initial list load failed', () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions({ loadError: 'HTTP 500' });
    renderList();
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
