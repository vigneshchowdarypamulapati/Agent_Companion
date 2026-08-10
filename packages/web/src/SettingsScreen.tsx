import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getDevice, unpairDevice, type DeviceInfo } from './api/devices';
import { UnauthorizedError } from './api/sessions';

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
          Couldn't load device info: {loadError}
        </p>
      )}

      {device && (
        <div className="bg-slate-800 rounded-md p-4 space-y-1">
          <p className="font-medium">{device.name}</p>
          <p className="text-sm text-slate-400 capitalize">{device.type}</p>
          <p className="text-sm text-slate-400">Paired {new Date(device.createdAt).toLocaleDateString()}</p>
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
              This will sign this device out and require a new pairing code to use it again. Continue?
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
