import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
