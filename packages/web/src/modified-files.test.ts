import { describe, it, expect } from 'vitest';
import { deriveModifiedFiles } from './modified-files';
import type { SessionEvent } from '@companion/protocol';

function toolUse(toolName: string, input: unknown): SessionEvent {
  return { type: 'tool_use', sessionId: 'sess-1', toolName, input, at: 1 };
}

describe('deriveModifiedFiles', () => {
  it('extracts file_path from Write/Edit/MultiEdit tool_use events', () => {
    const events = [
      toolUse('Write', { file_path: '/a.ts', content: '...' }),
      toolUse('Edit', { file_path: '/b.ts' }),
      toolUse('MultiEdit', { file_path: '/c.ts' }),
    ];
    expect(deriveModifiedFiles(events)).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('extracts notebook_path from NotebookEdit', () => {
    const events = [toolUse('NotebookEdit', { notebook_path: '/nb.ipynb' })];
    expect(deriveModifiedFiles(events)).toEqual(['/nb.ipynb']);
  });

  it('de-duplicates repeated edits to the same file', () => {
    const events = [toolUse('Edit', { file_path: '/a.ts' }), toolUse('Edit', { file_path: '/a.ts' })];
    expect(deriveModifiedFiles(events)).toEqual(['/a.ts']);
  });

  it('ignores non-file-editing tool_use events and non-tool_use events', () => {
    const events: SessionEvent[] = [
      toolUse('Bash', { command: 'ls' }),
      { type: 'assistant_text', sessionId: 'sess-1', text: 'hi', at: 1 },
      { type: 'turn_complete', sessionId: 'sess-1', at: 1 },
    ];
    expect(deriveModifiedFiles(events)).toEqual([]);
  });

  it('ignores tool_use events with a malformed input shape', () => {
    const events = [toolUse('Write', 'not-an-object'), toolUse('Write', { no_path_here: true })];
    expect(deriveModifiedFiles(events)).toEqual([]);
  });
});
