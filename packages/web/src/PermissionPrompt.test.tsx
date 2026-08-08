import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PermissionPrompt from './PermissionPrompt';

describe('PermissionPrompt', () => {
  it('sends an approved respond_to_permission command', async () => {
    const onSend = vi.fn();
    render(
      <PermissionPrompt
        sessionId="sess-1"
        requestId="req-1"
        toolName="Bash"
        input={{ command: 'ls' }}
        onSend={onSend}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(onSend).toHaveBeenCalledWith({
      type: 'respond_to_permission',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    });
  });

  it('sends a denied respond_to_permission command', async () => {
    const onSend = vi.fn();
    render(
      <PermissionPrompt
        sessionId="sess-1"
        requestId="req-1"
        toolName="Bash"
        input={{ command: 'ls' }}
        onSend={onSend}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /deny/i }));

    expect(onSend).toHaveBeenCalledWith({
      type: 'respond_to_permission',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: false,
    });
  });

  it('shows the tool name and input being requested', () => {
    render(
      <PermissionPrompt
        sessionId="sess-1"
        requestId="req-1"
        toolName="Bash"
        input={{ command: 'ls' }}
        onSend={() => {}}
      />
    );
    expect(screen.getByText(/bash/i)).toBeInTheDocument();
    expect(screen.getByText(/"command": "ls"/)).toBeInTheDocument();
  });
});
