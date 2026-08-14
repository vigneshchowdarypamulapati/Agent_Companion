import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DaemonOnboarding from './DaemonOnboarding';
import * as pairingApi from './api/pairing';
import { UnauthorizedError } from './api/sessions';

function renderOnboarding(token = 'tok-1', onUnauthorized = vi.fn()) {
  render(<DaemonOnboarding token={token} onUnauthorized={onUnauthorized} />);
  return onUnauthorized;
}

describe('DaemonOnboarding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows get-started instructions and a pairing code form', () => {
    renderOnboarding();
    expect(screen.getByText('Connect your daemon')).toBeInTheDocument();
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair daemon' })).toBeInTheDocument();
  });

  it('submitting a code calls claimPairingCode with this browser token and the code', async () => {
    const claim = vi.spyOn(pairingApi, 'claimPairingCode').mockResolvedValue(undefined);
    renderOnboarding('tok-1');

    await userEvent.type(screen.getByLabelText('Pairing code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    expect(claim).toHaveBeenCalledWith('tok-1', '123456');
  });

  it('shows a waiting-for-first-session confirmation after a successful pair', async () => {
    vi.spyOn(pairingApi, 'claimPairingCode').mockResolvedValue(undefined);
    renderOnboarding();

    await userEvent.type(screen.getByLabelText('Pairing code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    expect(await screen.findByText('Daemon paired')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your first session…')).toBeInTheDocument();
  });

  it('shows an inline error when claiming fails', async () => {
    vi.spyOn(pairingApi, 'claimPairingCode').mockRejectedValue(new Error('Invalid pairing code'));
    renderOnboarding();

    await userEvent.type(screen.getByLabelText('Pairing code'), '999999');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid pairing code');
  });

  it('calls onUnauthorized when claiming fails with UnauthorizedError', async () => {
    vi.spyOn(pairingApi, 'claimPairingCode').mockRejectedValue(new UnauthorizedError());
    const onUnauthorized = renderOnboarding();

    await userEvent.type(screen.getByLabelText('Pairing code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
