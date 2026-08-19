import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordProjectUsed, listKnownProjects } from './project-store.js';

let tempDir: string | undefined;

async function makeTempFilePath(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'companion-project-store-test-'));
  return join(tempDir, 'daemon-projects.json');
}

describe('project-store', () => {
  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('listKnownProjects returns an empty array when the file does not exist yet', async () => {
    const filePath = await makeTempFilePath();
    expect(await listKnownProjects({ filePath })).toEqual([]);
  });

  it('recordProjectUsed then listKnownProjects returns the recorded path with its timestamp', async () => {
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/my-project', { filePath, now: () => 1000 });

    expect(await listKnownProjects({ filePath })).toEqual([{ path: '/tmp/my-project', lastUsedAt: 1000 }]);
  });

  it('recordProjectUsed on an existing path updates its lastUsedAt rather than duplicating the entry', async () => {
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/my-project', { filePath, now: () => 1000 });
    await recordProjectUsed('/tmp/my-project', { filePath, now: () => 2000 });

    expect(await listKnownProjects({ filePath })).toEqual([{ path: '/tmp/my-project', lastUsedAt: 2000 }]);
  });

  it('recordProjectUsed on a new path adds it alongside existing entries', async () => {
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/project-a', { filePath, now: () => 1000 });
    await recordProjectUsed('/tmp/project-b', { filePath, now: () => 2000 });

    const result = await listKnownProjects({ filePath });
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ path: '/tmp/project-a', lastUsedAt: 1000 });
    expect(result).toContainEqual({ path: '/tmp/project-b', lastUsedAt: 2000 });
  });

  it('throws a clear error if the file exists but is not valid JSON', async () => {
    const filePath = await makeTempFilePath();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, 'not json', { mode: 0o600 });

    await expect(listKnownProjects({ filePath })).rejects.toThrow(/malformed/i);
  });

  it('recordProjectUsed on path A, then B, then A again preserves both entries with correct timestamps', async () => {
    // This test guards against the race condition fix being accidentally removed:
    // without serialization, B's entry could be lost when A is updated again.
    const filePath = await makeTempFilePath();
    await recordProjectUsed('/tmp/project-a', { filePath, now: () => 1000 });
    await recordProjectUsed('/tmp/project-b', { filePath, now: () => 2000 });
    await recordProjectUsed('/tmp/project-a', { filePath, now: () => 3000 });

    const result = await listKnownProjects({ filePath });
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ path: '/tmp/project-a', lastUsedAt: 3000 });
    expect(result).toContainEqual({ path: '/tmp/project-b', lastUsedAt: 2000 });
  });

  it('two concurrent recordProjectUsed calls (without awaiting between them) both survive', async () => {
    // This test directly verifies the serialization queue prevents lost updates:
    // issuing two calls without awaiting between them would trigger the race
    // condition without the queue, causing one to be silently lost.
    const filePath = await makeTempFilePath();
    const call1 = recordProjectUsed('/tmp/project-a', { filePath, now: () => 1000 });
    const call2 = recordProjectUsed('/tmp/project-b', { filePath, now: () => 2000 });

    await Promise.all([call1, call2]);

    const result = await listKnownProjects({ filePath });
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ path: '/tmp/project-a', lastUsedAt: 1000 });
    expect(result).toContainEqual({ path: '/tmp/project-b', lastUsedAt: 2000 });
  });
});
