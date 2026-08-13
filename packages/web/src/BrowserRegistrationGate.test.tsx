import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BrowserRegistrationGate from './BrowserRegistrationGate';
import * as devicesApi from './api/devices';
import { getStoredCredentials, clearStoredCredentials } from './storage';

const mockGetToken = vi.fn();
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: mockGetToken }),
}));

describe('BrowserRegistrationGate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearStoredCredentials();
  });

  it('registers the browser, stores credentials, and calls onRegistered', async () => {
    mockGetToken.mockResolvedValue('clerk-tok-1');
    vi.spyOn(devicesApi, 'registerBrowserDevice').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    const onRegistered = vi.fn();

    render(<BrowserRegistrationGate onRegistered={onRegistered} />);

    await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledWith({ token: 'tok-1', deviceId: 'dev-1' }));
    expect(getStoredCredentials()).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });

  it('shows an error if registration fails', async () => {
    mockGetToken.mockResolvedValue('clerk-tok-1');
    vi.spyOn(devicesApi, 'registerBrowserDevice').mockRejectedValue(new Error('Unauthorized'));

    render(<BrowserRegistrationGate onRegistered={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unauthorized');
  });

  it('retries registration when the user clicks Retry, and succeeds on the second attempt', async () => {
    mockGetToken.mockResolvedValue('clerk-tok-1');
    const register = vi
      .spyOn(devicesApi, 'registerBrowserDevice')
      .mockRejectedValueOnce(new Error('Relay unreachable'))
      .mockResolvedValueOnce({ token: 'tok-1', deviceId: 'dev-1' });
    const onRegistered = vi.fn();

    render(<BrowserRegistrationGate onRegistered={onRegistered} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Relay unreachable');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await vi.waitFor(() => expect(onRegistered).toHaveBeenCalledWith({ token: 'tok-1', deviceId: 'dev-1' }));
    expect(register).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getStoredCredentials()).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });
});
