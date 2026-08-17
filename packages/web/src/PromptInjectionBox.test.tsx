import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PromptInjectionBox from './PromptInjectionBox';
import type { CommandAckResult } from './use-relay-connection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('PromptInjectionBox', () => {
  it('sends an inject_prompt command with the typed text and clears the input once delivered', async () => {
    const onSend = vi.fn(async (): Promise<CommandAckResult> => ({ status: 'delivered' }));
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'follow up');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith({ type: 'inject_prompt', sessionId: 'sess-1', text: 'follow up' });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('does not send an empty prompt', async () => {
    const onSend = vi.fn(async (): Promise<CommandAckResult> => ({ status: 'delivered' }));
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables the input and button while waiting for permission', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled onSend={vi.fn()} />);

    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('uses the placeholder prop when provided and not disabled', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} placeholder="What's next?" onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText("What's next?")).toBeInTheDocument();
  });

  it('falls back to the default placeholder when none is provided', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText('Send a follow-up prompt')).toBeInTheDocument();
  });

  // --- the core regression: never lose typed text when the command can't be acked yet ---

  it('disables the button and announces "Sending" while a command is pending', async () => {
    const pending = deferred<CommandAckResult>();
    const onSend = vi.fn(() => pending.promise);
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent(/sending/i);
    // The text is still in the box while pending — nothing is cleared until delivery is confirmed.
    expect(input).toHaveValue('hello');

    pending.resolve({ status: 'delivered' });
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('THE regression: typing a reply while the socket is closed keeps the text, shows an error, and retry succeeds once reconnected', async () => {
    // Simulates exactly what relay-connection.ts does when the socket isn't open: it queues the
    // command and, if nothing acks it in time, resolves 'failed' rather than clearing state
    // (see RelayConnection.sendCommand). PromptInjectionBox must never clear the typed text on
    // that outcome, must show the user an actionable error, and a retry (once "reconnected",
    // i.e. once onSend starts resolving 'delivered') must succeed without retyping.
    const onSend = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', message: 'Timed out waiting for the daemon to acknowledge this command' })
      .mockResolvedValueOnce({ status: 'delivered' });

    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'are you still there?');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    // 1. The text survives — it is never cleared on failure.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(input).toHaveValue('are you still there?');

    // 2. The user sees a visible, actionable error. role="alert" is itself an assertive live
    //    region (announced on its own), so the polite role="status" span deliberately stays
    //    silent here rather than repeating the same failure a second time.
    expect(screen.getByRole('alert')).toHaveTextContent(/timed out waiting/i);
    expect(screen.getByRole('status')).not.toHaveTextContent(/timed out waiting/i);
    const retryButton = screen.getByRole('button', { name: /retry/i });

    // 3. Retry (after "reconnecting" — onSend now resolves delivered) succeeds and clears the
    //    original text, without the user having retyped anything.
    await userEvent.click(retryButton);
    await waitFor(() => expect(input).toHaveValue(''));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenNthCalledWith(2, { type: 'inject_prompt', sessionId: 'sess-1', text: 'are you still there?' });
  });

  it('does not clear text appended while the original submission is still pending', async () => {
    // Same failure class as "THE regression" above, but the danger here is the *clear*, not the
    // error path: the ack for an old snapshot arrives as 'delivered' (e.g. the queued command
    // finally got through) after the user has already appended more text. Clearing unconditionally
    // on 'delivered' would silently destroy the appended words even though nothing ever failed.
    const pending = deferred<CommandAckResult>();
    const onSend = vi.fn(() => pending.promise);
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith({ type: 'inject_prompt', sessionId: 'sess-1', text: 'hello' });

    // The input is never disabled while pending, precisely so this is possible.
    await userEvent.type(input, ' and check the logs');
    expect(input).toHaveValue('hello and check the logs');

    // The ack that resolves now is for the original 'hello' snapshot.
    pending.resolve({ status: 'delivered' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument());

    expect(input).toHaveValue('hello and check the logs');
  });

  it('restores the input and shows an error when onSend rejects unexpectedly', async () => {
    const onSend = vi.fn().mockRejectedValueOnce(new Error('boom'));
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(input).toHaveValue('hello');
  });

  it('disables Retry (and it does nothing when clicked) while a permission response is pending', async () => {
    const onSend = vi.fn().mockResolvedValueOnce({ status: 'failed', message: 'nope' });
    const { rerender } = render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'hello');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    // A permission request now blocks new commands — the daemon always rejects one while a
    // permission response is outstanding, same as the Send button already respects via `disabled`.
    rerender(<PromptInjectionBox sessionId="sess-1" disabled onSend={onSend} />);

    const retryButton = screen.getByRole('button', { name: /retry/i });
    expect(retryButton).toBeDisabled();
    await userEvent.click(retryButton);
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});
