import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as sessionsApi from './api/sessions';
import * as devicesApi from './api/devices';
import { clearStoredCredentials, storeCredentials } from './storage';
import * as useRelayConnectionModule from './use-relay-connection';

let mockSignedIn = false;
const mockSignOut = vi.fn();
// BrowserRegistrationGate (rendered by App's SignedIn branch) calls useAuth
// from this same mocked module, so it must be mocked here too even though
// this file's tests exercise it only indirectly.
const mockGetToken = vi.fn().mockResolvedValue('clerk-tok-1');
vi.mock('@clerk/clerk-react', () => ({
  SignedIn: ({ children }: { children: React.ReactNode }) => (mockSignedIn ? <>{children}</> : null),
  SignedOut: ({ children }: { children: React.ReactNode }) => (mockSignedIn ? null : <>{children}</>),
  SignIn: () => <div>Sign in to Companion</div>,
  useClerk: () => ({ signOut: mockSignOut }),
  useAuth: () => ({ getToken: mockGetToken }),
}));

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearStoredCredentials();
    window.history.pushState({}, '', '/');
    mockSignedIn = false;
    mockSignOut.mockClear();
  });

  it('shows the Clerk sign-in UI when signed out and there are no stored credentials', () => {
    render(<App />);
    expect(screen.getByText('Sign in to Companion')).toBeInTheDocument();
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

  it('registers this browser after Clerk sign-in and shows the session list', async () => {
    mockSignedIn = true;
    vi.spyOn(devicesApi, 'registerBrowserDevice').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(<App />);

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

  it('shows the settings screen at /settings and signs out of both layers after a confirmed unpair', async () => {
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

    expect(mockSignOut).toHaveBeenCalled();
  });
});
