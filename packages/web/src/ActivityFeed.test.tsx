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
      { type: 'events_dropped', sessionId: 's', at: 1 },
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
    expect(screen.getByText('Some activity was lost while disconnected from the relay')).toBeInTheDocument();
  });

  it('renders an adopted_history event as an expanded "Prior conversation" block', () => {
    render(
      <ActivityFeed
        events={[
          {
            type: 'adopted_history',
            sessionId: 's1',
            originalSessionId: 'orig-1',
            messages: [
              { role: 'user', text: 'fix the bug in auth.ts' },
              { role: 'assistant', text: 'Found it — the token check was inverted.' },
            ],
            truncated: false,
            at: Date.now(),
          },
        ]}
      />
    );

    expect(screen.getByText(/prior conversation/i)).toBeInTheDocument();
    expect(screen.getByText('fix the bug in auth.ts')).toBeInTheDocument();
    expect(screen.getByText('Found it — the token check was inverted.')).toBeInTheDocument();
  });

  it('shows a truncation notice when the history was capped', () => {
    render(
      <ActivityFeed
        events={[
          {
            type: 'adopted_history',
            sessionId: 's1',
            originalSessionId: 'orig-1',
            messages: [{ role: 'user', text: 'hello' }],
            truncated: true,
            at: Date.now(),
          },
        ]}
      />
    );

    expect(screen.getByText(/showing the most recent 50 messages/i)).toBeInTheDocument();
  });

  it('does not show a truncation notice when the history was not capped', () => {
    render(
      <ActivityFeed
        events={[
          {
            type: 'adopted_history',
            sessionId: 's1',
            originalSessionId: 'orig-1',
            messages: [{ role: 'user', text: 'hello' }],
            truncated: false,
            at: Date.now(),
          },
        ]}
      />
    );

    expect(screen.queryByText(/showing the most recent 50 messages/i)).not.toBeInTheDocument();
  });

  it('renders adopted_history alongside normal events in the same feed', () => {
    render(
      <ActivityFeed
        events={[
          { type: 'adopted_history', sessionId: 's1', originalSessionId: 'orig-1', messages: [{ role: 'user', text: 'hi' }], truncated: false, at: Date.now() },
          { type: 'assistant_text', sessionId: 's1', text: 'How can I help?', at: Date.now() },
        ]}
      />
    );

    expect(screen.getByText(/prior conversation/i)).toBeInTheDocument();
    expect(screen.getByText('How can I help?')).toBeInTheDocument();
  });
});
