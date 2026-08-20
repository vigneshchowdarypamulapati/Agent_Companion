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

/**
 * Serializes writes to the project store file to prevent lost-update races.
 *
 * Without serialization, two concurrent `recordProjectUsed` calls can interleave like this:
 *   call(A):  read file → {projects: [X]}
 *   call(B):  read file → {projects: [X]}       (B's read before A's write lands)
 *   call(A):  modify copy, write → [X, A]
 *   call(B):  modify its own copy (never saw A), write → [X, B]
 *                                                 ← A's entry is silently lost
 *
 * All writes chain onto this queue, so each call's read-modify-write completes before the next
 * one starts, preventing interleaving. The queue is wrapped with `.then(() => {}, () => {})` to
 * swallow failures — a failed write doesn't poison the queue for subsequent calls, but the
 * caller still sees the real error via the returned promise.
 */
let writeQueue: Promise<void> = Promise.resolve();

export async function listKnownProjects(options: { filePath: string }): Promise<KnownProject[]> {
  const data = await readFileOrEmpty(options.filePath);
  return data.projects;
}

/**
 * Upserts `path` with `lastUsedAt = now()` — updates the existing entry's timestamp if `path` is
 * already known, otherwise appends a new one. Called from `SessionManager.startSession` as the
 * single choke point both the local HTTP surface and the remote RPC `start_session` handler go
 * through, so a project's history is recorded correctly regardless of which door started it.
 *
 * Serializes writes (see `writeQueue` above) to ensure concurrent calls don't lose updates.
 */
export async function recordProjectUsed(
  path: string,
  options: { filePath: string; now?: () => number }
): Promise<void> {
  const now = options.now ?? Date.now;
  const task = writeQueue.then(async () => {
    const data = await readFileOrEmpty(options.filePath);
    const existing = data.projects.find((p) => p.path === path);
    if (existing) {
      existing.lastUsedAt = now();
    } else {
      data.projects.push({ path, lastUsedAt: now() });
    }
    await writeFileAtomicish(options.filePath, data);
  });
  // Chain the queue onto a version that swallows failure, so one failed write doesn't poison
  // every write queued after it — each call's own caller still sees the real rejection via the
  // `task` promise returned below, only the *queue's internal chain* needs to keep flowing.
  writeQueue = task.catch(() => {});
  return task;
}

/**
 * Resolves once every write enqueued so far on `writeQueue` — including any fire-and-forget call
 * a caller never awaited (e.g. `SessionManager.startSession`'s `void recordProjectUsed(...)`) —
 * has settled, success or failure.
 *
 * Exists for callers, mainly tests, that need to know the store is quiescent without making
 * production code await a write it deliberately treats as fire-and-forget. Because a
 * `recordProjectUsed` call updates `writeQueue` synchronously (before its first `await` runs —
 * see the doc comment above), this correctly waits for a write that was only just kicked off, as
 * long as it's called after the synchronous call that triggered it (e.g. after
 * `manager.startSession(...)` returns), not concurrently with it.
 *
 * `writeQueue` is already wrapped in `.catch(() => {})`, so awaiting it here never rejects.
 */
export function whenProjectStoreIdle(): Promise<void> {
  return writeQueue;
}
