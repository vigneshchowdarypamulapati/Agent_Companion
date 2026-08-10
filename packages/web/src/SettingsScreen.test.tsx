import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SettingsScreen from './SettingsScreen';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';
import * as pushApi from './api/push';
import * as pushNotifications from './push-notifications';

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

  describe('notifications section', () => {
    function mockDeviceLoad() {
      vi.spyOn(devicesApi, 'getDevice').mockResolvedValue({
        id: 'dev-1',
        type: 'browser',
        name: 'Chrome on Mac',
        createdAt: 1,
      });
    }

    it('renders nothing when push is not supported by the browser', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(false);

      renderSettings();

      await screen.findByText('Chrome on Mac');
      expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    });

    it('renders nothing when the relay has no VAPID key configured', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue(undefined);

      renderSettings();

      await screen.findByText('Chrome on Mac');
      expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    });

    it('shows an Enable button when push is available but not yet subscribed', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');

      renderSettings();

      expect(await screen.findByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
    });

    it('shows a Disable button when already subscribed', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('granted');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('subscribed');

      renderSettings();

      expect(await screen.findByRole('button', { name: /disable notifications/i })).toBeInTheDocument();
    });

    it('shows a blocked message instead of a button when permission was previously denied', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('denied');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');

      renderSettings();

      expect(await screen.findByText(/blocked in your browser settings/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /enable notifications/i })).not.toBeInTheDocument();
    });

    it('enables push notifications and shows the Disable button after clicking Enable', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');
      const enablePush = vi.spyOn(pushNotifications, 'enablePush').mockResolvedValue(undefined);

      renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /enable notifications/i }));

      expect(enablePush).toHaveBeenCalledWith('tok-1');
      expect(await screen.findByRole('button', { name: /disable notifications/i })).toBeInTheDocument();
    });

    it('shows an inline error and does not change state when enabling push fails', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');
      vi.spyOn(pushNotifications, 'enablePush').mockRejectedValue(
        new Error('Notification permission was not granted')
      );

      renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /enable notifications/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Notification permission was not granted');
      expect(screen.getByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
    });

    it('disables push notifications and shows the Enable button after clicking Disable', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('granted');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('subscribed');
      const disablePush = vi.spyOn(pushNotifications, 'disablePush').mockResolvedValue(undefined);

      renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /disable notifications/i }));

      expect(disablePush).toHaveBeenCalledWith('tok-1');
      expect(await screen.findByRole('button', { name: /enable notifications/i })).toBeInTheDocument();
    });

    it('calls onUnpaired if enabling push gets a 401', async () => {
      mockDeviceLoad();
      vi.spyOn(pushNotifications, 'isPushSupported').mockReturnValue(true);
      vi.spyOn(pushApi, 'getVapidPublicKey').mockResolvedValue('key');
      vi.spyOn(pushNotifications, 'getPermissionState').mockReturnValue('default');
      vi.spyOn(pushNotifications, 'getExistingSubscriptionState').mockResolvedValue('unsubscribed');
      vi.spyOn(pushNotifications, 'enablePush').mockRejectedValue(new UnauthorizedError());

      const onUnpaired = renderSettings();

      await userEvent.click(await screen.findByRole('button', { name: /enable notifications/i }));

      await waitFor(() => expect(onUnpaired).toHaveBeenCalled());
    });
  });
});
