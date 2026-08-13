import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getDevice, unpairDevice, type DeviceInfo } from './api/devices';
import { claimPairingCode } from './api/pairing';
import { UnauthorizedError } from './api/sessions';
import { getVapidPublicKey } from './api/push';
import {
  isPushSupported,
  getPermissionState,
  getExistingSubscriptionState,
  enablePush,
  disablePush,
} from './push-notifications';

export interface SettingsScreenProps {
  token: string;
  onUnpaired: () => void;
}

export default function SettingsScreen({ token, onUnpaired }: SettingsScreenProps) {
  const [device, setDevice] = useState<DeviceInfo | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [unpairError, setUnpairError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [pushAvailable, setPushAvailable] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>('default');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | undefined>();
  const [pairingCode, setPairingCode] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const [pairError, setPairError] = useState<string | undefined>();
  const [pairSucceeded, setPairSucceeded] = useState(false);
  const onUnpairedRef = useRef(onUnpaired);
  onUnpairedRef.current = onUnpaired;

  useEffect(() => {
    let cancelled = false;
    getDevice(token)
      .then((info) => {
        if (!cancelled) setDevice(info);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnpairedRef.current();
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    async function loadPushState() {
      if (!isPushSupported()) return;
      const publicKey = await getVapidPublicKey();
      if (cancelled || !publicKey) return;
      setPushAvailable(true);
      setPushPermission(getPermissionState());
      const state = await getExistingSubscriptionState();
      if (!cancelled) setPushSubscribed(state === 'subscribed');
    }
    // An unreachable relay or unexpected error here legitimately means "no notifications
    // section" — same as the VAPID-not-configured case above — so this is swallowed rather
    // than surfaced as a loadError.
    void loadPushState().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUnpair() {
    setBusy(true);
    setUnpairError(undefined);
    try {
      await unpairDevice(token);
      onUnpairedRef.current();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      setUnpairError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleClaimPairingCode(event: React.FormEvent) {
    event.preventDefault();
    setPairBusy(true);
    setPairError(undefined);
    setPairSucceeded(false);
    try {
      await claimPairingCode(token, pairingCode.trim());
      setPairingCode('');
      setPairSucceeded(true);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      // The relay's pairing errors are already user-actionable ("Invalid
      // pairing code", "Pairing code expired", …), so they're surfaced as-is.
      setPairError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairBusy(false);
    }
  }

  async function handleEnablePush() {
    setPushBusy(true);
    setPushError(undefined);
    try {
      await enablePush(token);
      setPushSubscribed(true);
      setPushPermission(getPermissionState());
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      setPushError(err instanceof Error ? err.message : String(err));
      setPushPermission(getPermissionState());
    } finally {
      setPushBusy(false);
    }
  }

  async function handleDisablePush() {
    setPushBusy(true);
    setPushError(undefined);
    try {
      await disablePush(token);
      setPushSubscribed(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnpairedRef.current();
        return;
      }
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 space-y-6 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Link to="/" className="text-sm text-slate-400 underline">
          Back
        </Link>
      </div>

      {loadError && (
        <p role="alert" className="bg-red-900 text-red-100 rounded-md px-4 py-3">
          {loadError}
        </p>
      )}

      {device && (
        <div className="bg-slate-800 rounded-md p-4 space-y-1">
          <p className="font-medium">{device.name}</p>
          <p className="text-sm text-slate-400 capitalize">{device.type}</p>
          <p className="text-sm text-slate-400">Paired {new Date(device.createdAt).toLocaleDateString()}</p>
        </div>
      )}

      <form onSubmit={handleClaimPairingCode} className="border-t border-slate-700 pt-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-300">Pair a daemon</h2>
        <p className="text-sm text-slate-400">
          Start the Companion daemon on your machine and enter the 6-digit code it prints.
        </p>
        <label htmlFor="pairing-code" className="block text-sm text-slate-400">
          Pairing code
        </label>
        <input
          id="pairing-code"
          name="pairing-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={pairingCode}
          onChange={(e) => setPairingCode(e.target.value)}
          className="w-full rounded-md bg-slate-800 px-3 py-2 tracking-widest"
        />
        <button
          type="submit"
          disabled={pairBusy || pairingCode.trim().length === 0}
          className="w-full rounded-md bg-blue-600 px-3 py-2 font-medium disabled:opacity-50"
        >
          {pairBusy ? 'Pairing…' : 'Pair daemon'}
        </button>
        {pairSucceeded && <p className="text-sm text-green-400">Daemon paired!</p>}
        {pairError && (
          <p role="alert" className="text-sm text-red-400">
            {pairError}
          </p>
        )}
      </form>

      {pushAvailable && (
        <div className="border-t border-slate-700 pt-4 space-y-3">
          <h2 className="text-sm font-medium text-slate-300">Notifications</h2>
          {pushPermission === 'denied' ? (
            <p className="text-sm text-slate-400">
              Notifications are blocked in your browser settings. Change your browser's site permissions to enable
              them.
            </p>
          ) : pushSubscribed ? (
            <div className="space-y-2">
              <p className="text-sm text-slate-400">Notifications are enabled for this device.</p>
              <button
                type="button"
                onClick={handleDisablePush}
                disabled={pushBusy}
                className="w-full rounded-md bg-slate-800 px-3 py-2 font-medium disabled:opacity-50"
              >
                {pushBusy ? 'Disabling…' : 'Disable notifications'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleEnablePush}
              disabled={pushBusy}
              className="w-full rounded-md bg-blue-600 px-3 py-2 font-medium disabled:opacity-50"
            >
              {pushBusy ? 'Enabling…' : 'Enable notifications'}
            </button>
          )}
          {pushError && (
            <p role="alert" className="text-sm text-red-400">
              {pushError}
            </p>
          )}
        </div>
      )}

      <div className="border-t border-slate-700 pt-4 space-y-3">
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="w-full rounded-md bg-red-700 px-3 py-2 font-medium"
          >
            Unpair this device
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-300">
              This will sign you out of this device and you'll need to sign in again to use it.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleUnpair}
                disabled={busy}
                className="flex-1 rounded-md bg-red-700 px-3 py-2 font-medium disabled:opacity-50"
              >
                {busy ? 'Unpairing…' : 'Confirm unpair'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-md bg-slate-800 px-3 py-2 font-medium disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {unpairError && (
          <p role="alert" className="text-sm text-red-400">
            {unpairError}
          </p>
        )}
      </div>
    </div>
  );
}
