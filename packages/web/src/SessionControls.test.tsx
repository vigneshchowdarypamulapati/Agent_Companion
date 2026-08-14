import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SessionControls from './SessionControls';

describe('SessionControls', () => {
  it('enables only Pause and Stop when running', () => {
    render(<SessionControls sessionId="sess-1" status="running" onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('enables only Resume and Stop when paused', () => {
    render(<SessionControls sessionId="sess-1" status="paused" onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('disables everything once stopped', () => {
    render(<SessionControls sessionId="sess-1" status="stopped" onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('disables Pause and Resume while waiting for permission, but Stop stays enabled', () => {
    render(<SessionControls sessionId="sess-1" status="waiting_permission" onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('enables Pause and Stop when waiting_input, same as running', () => {
    render(<SessionControls sessionId="sess-1" status="waiting_input" onSend={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('sends the pause command with the session id', async () => {
    const onSend = vi.fn();
    render(<SessionControls sessionId="sess-1" status="running" onSend={onSend} />);
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onSend).toHaveBeenCalledWith({ type: 'pause', sessionId: 'sess-1' });
  });

  it('sends the resume command with the session id', async () => {
    const onSend = vi.fn();
    render(<SessionControls sessionId="sess-1" status="paused" onSend={onSend} />);
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onSend).toHaveBeenCalledWith({ type: 'resume', sessionId: 'sess-1' });
  });

  it('sends the stop command with the session id', async () => {
    const onSend = vi.fn();
    render(<SessionControls sessionId="sess-1" status="running" onSend={onSend} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onSend).toHaveBeenCalledWith({ type: 'stop', sessionId: 'sess-1' });
  });
});
