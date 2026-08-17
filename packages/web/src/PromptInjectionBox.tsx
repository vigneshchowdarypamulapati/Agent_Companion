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
          // Clear only if the box still holds exactly what was submitted. The input is
          // deliberately never disabled while pending (see below), so a user can keep typing
          // during the up-to-10s ack wait — e.g. appending "...and check the logs" while the
          // original snapshot is still in flight. If we cleared unconditionally here, that
          // reconnect-delivered ack for the *old* snapshot would wipe out text the user added
          // since, silently destroying it — exactly the class of bug this component exists to
          // prevent. Comparing against the value actually submitted (not just "is it non-empty")
          // ensures only a still-matching snapshot gets cleared.
          setText((prev) => (prev === value ? '' : prev));
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
    // Mirrors the Send button's own guard (disabled while a permission response is pending —
    // the daemon rejects any command in that state) so Retry can't dispatch what the button
    // itself refuses to.
    if (disabled || !text.trim() || sendState.phase === 'pending') return;
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
        <div role="alert" className="flex items-center justify-between gap-2 bg-danger-bg text-danger-text rounded-md pl-3 pr-1 py-1 text-sm">
          <span>{sendState.message}</span>
          {/* min-h-11/min-w-11 (44px) meets both Android Material's 48dp and iOS's 44pt minimum
              touch target — the underline-only link this used to be was closer to the text's own
              14-20px line height. The alert's own padding is trimmed (pl-3 pr-1 py-1 above, vs.
              the previous px-3 py-2) so the button's own padding does the sizing work instead of
              stacking on top of it, keeping the banner from growing more than necessary. */}
          <button
            type="button"
            onClick={handleRetry}
            disabled={disabled}
            className="underline font-medium shrink-0 min-h-11 min-w-11 px-3 flex items-center justify-center disabled:opacity-50 disabled:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Screen-reader-only status announcement for the pending state: a phone user who tapped
          Send and moved their attention elsewhere (this is exactly the "reply from a push
          notification" scenario) must not have to keep watching the button to learn a send is in
          flight. The error case is deliberately NOT also announced here: role="alert" above is
          itself an assertive live region that screen readers announce as soon as it appears, so
          repeating its message in this aria-live="polite" span would announce the same failure
          twice. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending && 'Sending your reply…'}
      </span>
    </form>
  );
}
