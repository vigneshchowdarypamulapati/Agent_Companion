import type { SessionEvent } from '@companion/protocol';

const FILE_EDITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function deriveModifiedFiles(events: SessionEvent[]): string[] {
  const files = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    if (!FILE_EDITING_TOOLS.has(event.toolName)) continue;
    const filePath = extractFilePath(event.input);
    if (filePath) files.add(filePath);
  }
  return [...files];
}

function extractFilePath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const candidate = record.file_path ?? record.notebook_path;
  return typeof candidate === 'string' ? candidate : undefined;
}
