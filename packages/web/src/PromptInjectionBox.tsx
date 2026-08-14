import { useState, type FormEvent } from 'react';
import type { Command } from '@companion/protocol';

export interface PromptInjectionBoxProps {
  sessionId: string;
  disabled: boolean;
  onSend: (command: Command) => void;
}

export default function PromptInjectionBox({ sessionId, disabled, onSend }: PromptInjectionBoxProps) {
  const [text, setText] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    onSend({ type: 'inject_prompt', sessionId, text });
    setText('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={disabled}
        placeholder={disabled ? 'Waiting for a permission response…' : 'Send a follow-up prompt'}
        aria-label="Prompt"
        className="flex-1 rounded-md bg-panel px-3 py-2 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || text.trim().length === 0}
        className="rounded-md bg-accent hover:bg-accent-hover px-4 py-2 font-medium disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}
