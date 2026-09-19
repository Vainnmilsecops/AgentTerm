import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ManagedTaskContextStore } from './task-context-store';

async function fixture(
  run: (
    root: string,
    store: ManagedTaskContextStore,
    record: Awaited<ReturnType<ManagedTaskContextStore['put']>> & {
      taskId: string;
      sessionId: string;
      createdAt: number;
    },
    worktree: string,
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'agentterm-export-'));
  try {
    const store = new ManagedTaskContextStore(join(root, 'private'));
    const record = {
      ...(await store.put('task', {
        name: 'ghi-chú.txt',
        mime: 'text/plain',
        bytes: Buffer.from('Xin chào'),
      })),
      taskId: 'task',
      sessionId: 'session',
      createdAt: 1,
    };
    const worktree = join(root, 'worktree');
    await mkdir(worktree);
    await run(root, store, record, worktree);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe('verified context export', () => {
  it('exports exact bytes using a relative path and reuses an unchanged copy', async () => {
    await fixture(async (_root, store, record, worktree) => {
      const path = await store.exportToWorktree(record, worktree);
      expect(path).toBe(`agentterm-context/${record.id}.txt`);
      expect(await readFile(join(worktree, path), 'utf8')).toBe('Xin chào');
      expect(await store.exportToWorktree(record, worktree)).toBe(path);
      expect(await readdir(join(worktree, 'agentterm-context'))).toHaveLength(1);
    });
  });
  it('refuses tampered source bytes and leaves the worktree untouched', async () => {
    await fixture(async (root, store, record, worktree) => {
      await writeFile(
        join(root, 'private', createHash('sha256').update('task').digest('hex'), record.id),
        'modified',
      );
      await expect(store.exportToWorktree(record, worktree)).rejects.toThrow();
      expect(await readdir(worktree)).toEqual([]);
    });
  });
  it('never overwrites an existing changed export', async () => {
    await fixture(async (_root, store, record, worktree) => {
      const path = await store.exportToWorktree(record, worktree);
      await writeFile(join(worktree, path), 'user work');
      await expect(store.exportToWorktree(record, worktree)).rejects.toThrow();
      expect(await readFile(join(worktree, path), 'utf8')).toBe('user work');
    });
  });
  it('refuses a destination junction', async () => {
    await fixture(async (root, store, record, worktree) => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      await symlink(outside, join(worktree, 'agentterm-context'), 'junction');
      await expect(store.exportToWorktree(record, worktree)).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    });
  });
});
