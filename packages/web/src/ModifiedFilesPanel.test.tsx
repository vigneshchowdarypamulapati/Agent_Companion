import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ModifiedFilesPanel from './ModifiedFilesPanel';
import type { SessionEvent } from '@companion/protocol';

describe('ModifiedFilesPanel', () => {
  it('shows a placeholder when no files have been modified', () => {
    render(<ModifiedFilesPanel events={[]} />);
    expect(screen.getByText(/no files modified yet/i)).toBeInTheDocument();
  });

  it('lists de-duplicated modified files', () => {
    const events: SessionEvent[] = [
      { type: 'tool_use', sessionId: 's', toolName: 'Edit', input: { file_path: '/a.ts' }, at: 1 },
      { type: 'tool_use', sessionId: 's', toolName: 'Edit', input: { file_path: '/a.ts' }, at: 2 },
      { type: 'tool_use', sessionId: 's', toolName: 'Write', input: { file_path: '/b.ts' }, at: 3 },
    ];
    render(<ModifiedFilesPanel events={events} />);

    expect(screen.getByText('/a.ts')).toBeInTheDocument();
    expect(screen.getByText('/b.ts')).toBeInTheDocument();
  });
});
