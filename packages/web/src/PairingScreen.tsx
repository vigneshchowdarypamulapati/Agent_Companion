import { useState, type FormEvent } from 'react';
import { requestPairingCode, redeemPairingCode } from './api/pairing';
import { storeCredentials } from './storage';

export interface PairingScreenProps {
  onPaired: () => void;
}

export default function PairingScreen({ onPaired }: PairingScreenProps) {
  const [code, setCode] = useState('');
  const [generatedCode, setGeneratedCode] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function handleGetCode() {
    setError(undefined);
    setBusy(true);
    try {
      const result = await requestPairingCode();
      setGeneratedCode(result.code);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const result = await redeemPairingCode(code);
      storeCredentials(result);
      onPaired();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <h1 className="text-xl font-semibold text-center">Pair this device</h1>

        <form onSubmit={handleSubmit} className="space-y-3">
          <label htmlFor="pairing-code" className="block text-sm text-slate-300">
            Enter pairing code
          </label>
          <input
            id="pairing-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            maxLength={6}
            className="w-full rounded-md bg-slate-800 px-3 py-2 text-lg tracking-widest text-center"
            placeholder="000000"
          />
          <button
            type="submit"
            disabled={busy || code.length === 0}
            className="w-full rounded-md bg-blue-600 px-3 py-2 font-medium disabled:opacity-50"
          >
            Pair
          </button>
        </form>

        {error && (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="border-t border-slate-700 pt-4 text-center space-y-2">
          <p className="text-sm text-slate-400">Don&apos;t have a code?</p>
          <button
            type="button"
            onClick={handleGetCode}
            disabled={busy}
            className="rounded-md bg-slate-800 px-3 py-2 text-sm disabled:opacity-50"
          >
            Get a pairing code
          </button>
          {generatedCode && <p className="text-lg font-mono tracking-widest">{generatedCode}</p>}
        </div>
      </div>
    </div>
  );
}
