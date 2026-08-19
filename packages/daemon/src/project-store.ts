import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface KnownProject {
  path: string;
  lastUsedAt: number;
}

interface ProjectStoreFile {
  projects: KnownProject[];
}

/**
 * Persists the daemon's "projects it has started a session in before" list to a small JSON file
 * — same pattern as device-auth.ts's device-token file, including the 0o600 permission: a
 * project path list reveals filesystem structure on this machine, so it gets the same
 * owner-only-read treatment as the credential file does.
 */
async function readFileOrEmpty(filePath: string): Promise<ProjectStoreFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Project store file at ${filePath} is malformed`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as ProjectStoreFile).projects)
  ) {
    throw new Error(`Project store file at ${filePath} is malformed`);
  }
  return parsed as ProjectStoreFile;
}

async function writeFileAtomicish(filePath: string, data: ProjectStoreFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function listKnownProjects(options: { filePath: string }): Promise<KnownProject[]> {
  const data = await readFileOrEmpty(options.filePath);
  return data.projects;
}

/**
 * Upserts `path` with `lastUsedAt = now()` — updates the existing entry's timestamp if `path` is
 * already known, otherwise appends a new one. Called from `SessionManager.startSession` as the
 * single choke point both the local HTTP surface and the remote RPC `start_session` handler go
 * through, so a project's history is recorded correctly regardless of which door started it.
 */
export async function recordProjectUsed(
  path: string,
  options: { filePath: string; now?: () => number }
): Promise<void> {
  const now = options.now ?? Date.now;
  const data = await readFileOrEmpty(options.filePath);
  const existing = data.projects.find((p) => p.path === path);
  if (existing) {
    existing.lastUsedAt = now();
  } else {
    data.projects.push({ path, lastUsedAt: now() });
  }
  await writeFileAtomicish(options.filePath, data);
}
