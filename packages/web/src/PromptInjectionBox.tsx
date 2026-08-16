import { useState, type FormEvent } from 'react';
import type { Command } from '@companion/protocol';
import type { CommandAckResult } from './use-relay-connection';

export interface PromptInjectionBoxProps {
  sessionId: string;
  disabled: boolean;
  placeholder?: string;
  /**
   * Must resolve (never reject — see CommandAckResult/RelayConnection) once the command's
   * delivery outcome is known. This component relies on that: the typed text is only cleared
   * once the promise resolves 'delivered', so a reply typed while the socket is closed (the
   * normal state for a phone that just woke up) survives until the daemon actually has it, not
   * until the browser merely attempted to send it.
   */
  onSend: (command: Command) => Promise<CommandAckResult>;
}

type SendState =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'error'; message: string };

const DEFAULT_ERROR_MESSAGE = 'Failed to send. Check your connection and try again.';

export default function PromptInjectionBox({ sessionId, disabled, placeholder, onSend }: PromptInjectionBoxProps) {
  const [text, setText] = useState('');
  const [sendState, setSendState] = useState<SendState>({ phase: 'idle' });

  // Submits `value` as an inject_prompt command. The text is only cleared on a 'delivered'
  // result — on 'failed' (whether a real dispatch failure or the client-side ack timeout) it
  // stays in the box exactly as typed, and the error banner below offers a one-tap retry that
  // resubmits the same text without the user having to retype it.
  function submit(value: string) {
    setSendState({ phase: 'pending' });
    Promise.resolve(onSend({ type: 'inject_prompt', sessionId, text: value }))
      .then((result: CommandAckResult | undefined) => {
        if (result?.status === 'delivered') {
          setText('');
          setSendState({ phase: 'idle' });
        } else {
          setSendState({ phase: 'error', message: result?.message ?? DEFAULT_ERROR_MESSAGE });
        }
      })
      .catch(() => {
        setSendState({ phase: 'error', message: DEFAULT_ERROR_MESSAGE });
      });
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || sendState.phase === 'pending') return;
    submit(text);
  }

  function handleRetry() {
    if (!text.trim() || sendState.phase === 'pending') return;
    submit(text);
  }

  const pending = sendState.phase === 'pending';

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          placeholder={disabled ? 'Waiting for a permission response…' : (placeholder ?? 'Send a follow-up prompt')}
          aria-label="Prompt"
          className="flex-1 rounded-md bg-panel px-3 py-2 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || pending || text.trim().length === 0}
          className="rounded-md bg-accent hover:bg-accent-hover px-4 py-2 font-medium disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {sendState.phase === 'error' && (
        <div role="alert" className="flex items-center justify-between gap-2 bg-danger-bg text-danger-text rounded-md px-3 py-2 text-sm">
          <span>{sendState.message}</span>
          <button type="button" onClick={handleRetry} className="underline font-medium shrink-0">
            Retry
          </button>
        </div>
      )}

      {/* Screen-reader-only status announcement: a phone user who tapped Send and moved their
          attention elsewhere (this is exactly the "reply from a push notification" scenario)
          must not have to keep watching the button to learn their reply failed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending && 'Sending your reply…'}
        {sendState.phase === 'error' && `Failed to send: ${sendState.message}`}
      </span>
    </form>
  );
}
