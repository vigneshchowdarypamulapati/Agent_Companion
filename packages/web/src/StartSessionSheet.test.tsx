import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import StartSessionSheet from './StartSessionSheet';
import * as sessionsProviderModule from './SessionsProvider';
import { RpcError } from './relay-connection';
import { RPC_ERROR_CODES } from '@companion/protocol';

function mockCallDaemon(impl: (method: string, params?: unknown) => Promise<unknown>) {
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [],
    loaded: true,
    connectionState: 'live',
    loadError: undefined,
    dismissSession: vi.fn(),
    sendCommand: vi.fn(),
    callDaemon: impl,
    subscribe: vi.fn(() => () => {}),
  });
}

const oneProject = [{ path: '/home/me/companion', displayName: 'companion', source: 'history' as const, lastUsedAt: 1000 }];

function renderSheet(onStarted = vi.fn(), onClose = vi.fn()) {
  return render(
    <MemoryRouter>
      <StartSessionSheet onStarted={onStarted} onClose={onClose} />
    </MemoryRouter>
  );
}

describe('StartSessionSheet', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads and shows the project list from list_projects', async () => {
    mockCallDaemon(async (method) => (method === 'list_projects' ? oneProject : undefined));
    renderSheet();
    expect(await screen.findByRole('button', { name: /companion/ })).toBeInTheDocument();
  });

  it('after picking a project, shows a prompt input; submitting calls start_session and onStarted with the new id', async () => {
    const onStarted = vi.fn();
    mockCallDaemon(async (method, params) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'start_session') {
        expect(params).toEqual({ projectPath: '/home/me/companion', prompt: 'do the thing' });
        return { id: 'new-session-1', status: 'running' };
      }
      throw new Error('unexpected method');
    });
    renderSheet(onStarted);

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));
    await userEvent.type(screen.getByRole('textbox', { name: /what should claude do/i }), 'do the thing');
    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('new-session-1'));
  });

  it('preserves the typed prompt and shows the typed error message when start_session fails', async () => {
    mockCallDaemon(async (method) => {
      if (method === 'list_projects') return oneProject;
      if (method === 'start_session') {
        throw new RpcError(RPC_ERROR_CODES.CONCURRENT_SESSION_LIMIT, "You've reached the limit of concurrent sessions. Stop one before starting another.");
      }
      throw new Error('unexpected method');
    });
    renderSheet();

    await userEvent.click(await screen.findByRole('button', { name: /companion/ }));
    const promptBox = screen.getByRole('textbox', { name: /what should claude do/i });
    await userEvent.type(promptBox, 'do the thing');
    await userEvent.click(screen.getByRole('button', { name: /^start$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/limit of concurrent sessions/i);
    expect(promptBox).toHaveValue('do the thing');
  });
});
