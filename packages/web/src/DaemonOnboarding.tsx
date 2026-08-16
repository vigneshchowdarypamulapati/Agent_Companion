import { useState, type FormEvent } from 'react';
import { claimPairingCode } from './api/pairing';
import { UnauthorizedError } from './api/sessions';

export interface DaemonOnboardingProps {
  token: string;
  onUnauthorized: () => void;
}

export default function DaemonOnboarding({ token, onUnauthorized }: DaemonOnboardingProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [paired, setPaired] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await claimPairingCode(token, code.trim());
      setPaired(true);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (paired) {
    return (
      <div role="status" className="bg-panel rounded-md p-4 space-y-1 text-center">
        <p className="font-medium text-ink">Daemon paired</p>
        <p className="text-sm text-ink-muted">Waiting for your first session…</p>
      </div>
    );
  }

  return (
    <div className="bg-panel rounded-md p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="font-medium text-ink">Connect your daemon</h2>
        <p className="text-sm text-ink-muted">
          Companion controls Claude Code sessions through a small daemon that runs on your machine.
        </p>
      </div>
      <ol className="text-sm text-ink-muted space-y-1 list-decimal list-inside">
        <li>Start the Companion daemon on the machine you run Claude Code on.</li>
        <li>It prints a code (like <code>ABCD-1234</code>) in the terminal.</li>
        <li>
          Enter that code below — case doesn't matter and the hyphen is optional. It expires after 5 minutes, so
          just restart the daemon for a fresh one if it does.
        </li>
      </ol>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="onboarding-pairing-code" className="block text-sm text-ink-muted">
          Pairing code
        </label>
        <input
          id="onboarding-pairing-code"
          name="onboarding-pairing-code"
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          maxLength={12}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded-md bg-canvas px-3 py-2 tracking-widest"
        />
        <button
          type="submit"
          disabled={busy || code.trim().length === 0}
          className="w-full rounded-md bg-accent hover:bg-accent-hover px-3 py-2 font-medium disabled:opacity-50"
        >
          {busy ? 'Pairing…' : 'Pair daemon'}
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger-light">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
