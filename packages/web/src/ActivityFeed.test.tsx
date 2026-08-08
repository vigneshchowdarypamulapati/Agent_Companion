import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActivityFeed from './ActivityFeed';
import type { SessionEvent } from '@companion/protocol';

describe('ActivityFeed', () => {
  it('shows a placeholder when there are no events', () => {
    render(<ActivityFeed events={[]} />);
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });

  it('renders a readable line for each event type', () => {
    const events: SessionEvent[] = [
      { type: 'session_started', sessionId: 's', projectPath: '/tmp/project', at: 1 },
      { type: 'assistant_text', sessionId: 's', text: 'Hello', at: 1 },
      { type: 'tool_use', sessionId: 's', toolName: 'Bash', input: {}, at: 1 },
      { type: 'tool_result', sessionId: 's', toolName: 'Bash', isError: false, at: 1 },
      { type: 'permission_request', sessionId: 's', requestId: 'r', toolName: 'Bash', input: {}, at: 1 },
      { type: 'permission_resolved', sessionId: 's', requestId: 'r', approved: true, at: 1 },
      { type: 'turn_complete', sessionId: 's', at: 1 },
      { type: 'error', sessionId: 's', message: 'boom', at: 1 },
      { type: 'command_failed', sessionId: 's', message: 'nope', at: 1 },
      { type: 'stopped', sessionId: 's', at: 1 },
    ];
    render(<ActivityFeed events={events} />);

    expect(screen.getByText('Session started in /tmp/project')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    expect(screen.getByText('Used Bash')).toBeInTheDocument();
    expect(screen.getByText('Bash completed')).toBeInTheDocument();
    expect(screen.getByText('Requesting permission to use Bash')).toBeInTheDocument();
    expect(screen.getByText('Permission approved')).toBeInTheDocument();
    expect(screen.getByText('Turn complete')).toBeInTheDocument();
    expect(screen.getByText('Error: boom')).toBeInTheDocument();
    expect(screen.getByText('Command failed: nope')).toBeInTheDocument();
    expect(screen.getByText('Session stopped')).toBeInTheDocument();
  });
});
