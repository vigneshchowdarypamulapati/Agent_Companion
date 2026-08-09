import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionsProvider, useSessions } from './SessionsProvider';
import * as sessionsApi from './api/sessions';
import * as useRelayConnectionModule from './use-relay-connection';

function Consumer() {
  const { sessions, loaded } = useSessions();
  if (!loaded) return <p>loading</p>;
  return <p>{sessions.length} sessions</p>;
}

describe('SessionsProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('provides the sessions store to descendants', async () => {
    vi.spyOn(sessionsApi, 'getActiveSessions').mockResolvedValue([]);
    vi.spyOn(useRelayConnectionModule, 'useRelayConnection').mockReturnValue({
      connected: true,
      sendCommand: vi.fn(),
    });

    render(
      <SessionsProvider token="tok-1" onUnauthorized={() => {}}>
        <Consumer />
      </SessionsProvider>
    );

    expect(await screen.findByText('0 sessions')).toBeInTheDocument();
  });

  it('useSessions throws when called outside a SessionsProvider', () => {
    // Suppress the React error-boundary console.error noise this specific,
    // expected throw produces.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow('useSessions must be used within a SessionsProvider');
    consoleSpy.mockRestore();
  });
});
