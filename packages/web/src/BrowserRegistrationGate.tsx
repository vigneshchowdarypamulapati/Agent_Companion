import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { registerBrowserDevice } from './api/devices';
import { storeCredentials, type DeviceCredentials } from './storage';

export interface BrowserRegistrationGateProps {
  onRegistered: (credentials: DeviceCredentials) => void;
}

/**
 * Runs once per browser: exchanges the signed-in Clerk session for this
 * browser's own long-lived companion device token, so every request after
 * this uses the existing device-token scheme unchanged.
 */
export default function BrowserRegistrationGate({ onRegistered }: BrowserRegistrationGateProps) {
  const { getToken } = useAuth();
  const [error, setError] = useState<string | undefined>();
  // Bumping this re-runs the effect below. This screen is the only thing
  // between a new user and the entire product, so a transient failure here
  // (relay restarting, offline for a moment) must be recoverable in place
  // rather than requiring a full page reload.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const clerkToken = await getToken();
        if (!clerkToken) throw new Error('Not signed in');
        const result = await registerBrowserDevice(clerkToken);
        storeCredentials(result);
        if (!cancelled) onRegistered(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, onRegistered, attempt]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
      {error ? (
        <div className="space-y-3 text-center">
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              setError(undefined);
              setAttempt((n) => n + 1);
            }}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium"
          >
            Retry
          </button>
        </div>
      ) : (
        <p className="text-sm text-slate-400">Setting up this browser…</p>
      )}
    </div>
  );
}
