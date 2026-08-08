import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PairingScreen from './PairingScreen';
import * as pairingApi from './api/pairing';
import { getStoredCredentials } from './storage';

describe('PairingScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    cleanup();
  });

  it('generates a pairing code and displays it', async () => {
    vi.spyOn(pairingApi, 'requestPairingCode').mockResolvedValue({ code: '123456', expiresAt: Date.now() + 60000 });
    render(<PairingScreen onPaired={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /get a pairing code/i }));

    expect(await screen.findByText('123456')).toBeInTheDocument();
  });

  it('redeems a code, stores credentials, and calls onPaired', async () => {
    vi.spyOn(pairingApi, 'redeemPairingCode').mockResolvedValue({ token: 'tok-1', deviceId: 'dev-1' });
    const onPaired = vi.fn();
    render(<PairingScreen onPaired={onPaired} />);

    await userEvent.type(screen.getByLabelText(/enter pairing code/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledOnce());
    expect(getStoredCredentials()).toEqual({ token: 'tok-1', deviceId: 'dev-1' });
  });

  it('shows an error and does not store credentials when redeeming fails', async () => {
    vi.spyOn(pairingApi, 'redeemPairingCode').mockRejectedValue(new Error('Invalid or expired pairing code'));
    render(<PairingScreen onPaired={() => {}} />);

    await userEvent.type(screen.getByLabelText(/enter pairing code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /^pair$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or expired pairing code');
    expect(getStoredCredentials()).toBeUndefined();
  });

  it('shows an error if requesting a code fails', async () => {
    vi.spyOn(pairingApi, 'requestPairingCode').mockRejectedValue(new Error('HTTP 500'));
    render(<PairingScreen onPaired={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /get a pairing code/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
