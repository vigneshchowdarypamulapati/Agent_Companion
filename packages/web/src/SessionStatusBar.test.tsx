import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionStatusBar from './SessionStatusBar';

describe('SessionStatusBar', () => {
  it('shows the status label and project path when a session is active', () => {
    render(<SessionStatusBar status="running" projectPath="/tmp/project" connectionState="live" />);
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('/tmp/project')).toBeInTheDocument();
  });

  it('shows a reconnecting indicator when not connected', () => {
    render(<SessionStatusBar status="running" projectPath="/tmp/project" connectionState="reconnecting" />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('shows a live indicator when connected', () => {
    render(<SessionStatusBar status="running" projectPath="/tmp/project" connectionState="live" />);
    expect(screen.getByText('live')).toBeInTheDocument();
  });
});
