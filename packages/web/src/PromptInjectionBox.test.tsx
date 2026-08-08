import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PromptInjectionBox from './PromptInjectionBox';

describe('PromptInjectionBox', () => {
  it('sends an inject_prompt command with the typed text and clears the input', async () => {
    const onSend = vi.fn();
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    const input = screen.getByLabelText('Prompt');
    await userEvent.type(input, 'follow up');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith({ type: 'inject_prompt', sessionId: 'sess-1', text: 'follow up' });
    expect(input).toHaveValue('');
  });

  it('does not send an empty prompt', async () => {
    const onSend = vi.fn();
    render(<PromptInjectionBox sessionId="sess-1" disabled={false} onSend={onSend} />);

    await userEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables the input and button while waiting for permission', () => {
    render(<PromptInjectionBox sessionId="sess-1" disabled onSend={() => {}} />);

    expect(screen.getByLabelText('Prompt')).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });
});
