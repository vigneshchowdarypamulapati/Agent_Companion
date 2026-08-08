import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionStatusBar from './SessionStatusBar';

describe('SessionStatusBar', () => {
  it('shows the empty state when there is no active session', () => {
    render(<SessionStatusBar status="none" connected />);
    expect(screen.getByText('No Active Sessions')).toBeInTheDocument();
  });

  it('shows the status label and project path when a session is active', () => {
    render(<SessionStatusBar status="running" projectPath="/tmp/project" connected />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
  });

  it('shows a reconnecting indicator when not connected', () => {
    render(<SessionStatusBar status="running" connected={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('shows a live indicator when connected', () => {
    render(<SessionStatusBar status="running" connected />);
    expect(screen.getByText('live')).toBeInTheDocument();
  });
});
