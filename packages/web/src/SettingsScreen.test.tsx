import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SettingsScreen from './SettingsScreen';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';

function renderSettings(token = 'tok-1', onUnpaired = vi.fn()) {
  render(
    <MemoryRouter>
      <SettingsScreen token={token} onUnpaired={onUnpaired} />
    </MemoryRouter>
  );
  return onUnpaired;
}

describe('SettingsScreen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the device's name, type, and paired-since date", async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: new Date('2026-01-15').getTime(),
    });

    renderSettings();

    expect(await screen.findByText('Chrome on Mac')).toBeInTheDocument();
    expect(screen.getByText('browser')).toBeInTheDocument();
    expect(screen.getByText(/paired/i)).toBeInTheDocument();
  });

  it('shows an inline error when loading device info fails', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockRejectedValue(new Error('HTTP 500'));

    renderSettings();

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
  });

  it('calls onUnpaired immediately if loading device info gets a 401', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockRejectedValue(new UnauthorizedError());

    const onUnpaired = renderSettings();

    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
  });

  it('requires confirmation before unpairing', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    const unpairDevice = vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);

    renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));

    expect(unpairDevice).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /confirm unpair/i })).toBeInTheDocument();
  });

  it('unpairs and calls onUnpaired after confirming', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);

    const onUnpaired = renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
  });

  it('cancelling the confirm step does not unpair', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    const unpairDevice = vi.spyOn(devicesApi, 'unpairDevice').mockResolvedValue(undefined);

    renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.getByRole('button', { name: /unpair this device/i })).toBeInTheDocument();
    expect(unpairDevice).not.toHaveBeenCalled();
  });

  it('shows an inline error and does not call onUnpaired when the unpair request fails', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockRejectedValue(new Error('HTTP 500'));

    const onUnpaired = renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
    expect(onUnpaired).not.toHaveBeenCalled();
  });

  it('calls onUnpaired immediately if the unpair request gets a 401', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });
    vi.spyOn(devicesApi, 'unpairDevice').mockRejectedValue(new UnauthorizedError());

    const onUnpaired = renderSettings();

    await screen.findByText('Chrome on Mac');
    await userEvent.click(screen.getByRole('button', { name: /unpair this device/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm unpair/i }));

    await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
  });

  it('has a link back to the session list', async () => {
    vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
      id: 'dev-1',
      type: 'browser',
      name: 'Chrome on Mac',
      createdAt: 1,
    });

    renderSettings();

    await screen.findByText('Chrome on Mac');
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute('href', '/');
  });
});
