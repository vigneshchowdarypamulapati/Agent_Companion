import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as pairingApi from './api/pairing';
import * as sessionsApi from './api/sessions';
import * as devicesApi from './api/devices';
import { clearStoredCredentials, storeCredentials } from './storage';
import * as useRelayConnectionModule from './use-relay-connection';

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearStoredCredentials();
    window.history.pushState({}, '', '/');
  });

  it('shows PairingScreen when there are no stored credentials', () => {
    render(<App />);
    expect(screen.getByText('Pair this device')).toBeInTheDocument();
  });

  it('shows the session list when credentials are already stored', async () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(<App />);

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('switches to the session list after pairing succeeds', async () => {
    vi.spyOn(pairingApi, 'redeemPairingCode').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(<App />);

    await userEvent.type(screen.getByLabelText(/enter pairing code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('redirects an unknown path to the session list', async () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });
    window.history.pushState({}, '', '/some/unknown/path');

    render(<App />);

    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
  });

  it('shows the settings screen at /settings and returns to the pairing screen after a confirmed unpair', async () => {
    storeCredentials({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Test Browser',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);
    window.history.pushState({}, '', '/settings');

    render(<App />);

    await screen.findByText('Test Browser');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    expect(await screen.findByText('Pair this device')).toBeInTheDocument();
  });
});
