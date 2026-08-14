import type { SessionEvent } from '@companion/protocol';
import { deriveModifiedFiles } from './modified-files';

export interface ModifiedFilesPanelProps {
  events: SessionEvent[];
}

export default function ModifiedFilesPanel({ events }: ModifiedFilesPanelProps) {
  const files = deriveModifiedFiles(events);
  if (files.length === 0) {
    return <p className="text-sm text-ink-faint">No files modified yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {files.map((file) => (
        <li key={file} className="text-sm font-mono bg-panel rounded-md px-3 py-1.5">
          {file}
        </li>
      ))}
    </ul>
  );
}
