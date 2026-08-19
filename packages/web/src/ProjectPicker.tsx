import { useState } from 'react';

export interface ProjectListEntry {
  path: string;
  displayName: string;
  source: 'history' | 'configured';
  lastUsedAt: number | undefined;
}

export interface ProjectPickerProps {
  /** Already sorted by the caller (most-recently-used history first, then configured
   * alphabetically) — mirrors exactly what the daemon's list_projects RPC returns, so this
   * component does no re-sorting of its own. */
  projects: ProjectListEntry[];
  onSelect: (project: ProjectListEntry) => void;
}

export default function ProjectPicker({ projects, onSelect }: ProjectPickerProps) {
  const [query, setQuery] = useState('');
  const filtered = projects.filter((p) => p.displayName.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="space-y-3">
      <input
        type="search"
        role="searchbox"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search projects…"
        aria-label="Search projects"
        className="w-full rounded-md bg-panel px-3 py-2"
      />
      {projects.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No projects yet — configure a projects folder on your computer, or start one locally to get going.
        </p>
      ) : (
        <ul className="space-y-1 max-h-80 overflow-y-auto">
          {filtered.map((project) => (
            <li key={project.path}>
              <button
                type="button"
                onClick={() => onSelect(project)}
                className="w-full text-left rounded-md bg-panel hover:bg-border px-3 py-2"
              >
                <span className="font-medium">{project.displayName}</span>
                {project.source === 'configured' && project.lastUsedAt === undefined && (
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-border text-ink-muted">First time</span>
                )}
                <p className="text-xs text-ink-faint truncate">{project.path}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
