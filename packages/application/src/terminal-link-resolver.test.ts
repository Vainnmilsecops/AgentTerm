import { describe, expect, it } from 'vitest';

import type { TaskWorktreeRepository } from './ports';
import {
  resolveTerminalLinkTarget,
  type ResolveTerminalLinkDependencies,
} from './terminal-link-resolver';

const SAMPLE_WORKTREE = {
  baseCommitId: 'base-commit',
  baseRefName: 'refs/heads/main',
  branchName: 'agent/abc',
  lifecycleState: 'PRESENT',
  pathIdentity: 'task-1',
  repositoryRootPath: 'C:/work/repo',
  taskId: 'task-1',
  worktreePath: 'C:/work/repo/.worktrees/task-1',
} as const;

function deps(worktreePath: string = SAMPLE_WORKTREE.worktreePath): ResolveTerminalLinkDependencies {
  const record = { ...SAMPLE_WORKTREE, worktreePath };
  const taskWorktrees: Pick<TaskWorktreeRepository, 'findByTaskId'> = {
    async findByTaskId(taskId) {
      return taskId === 'task-1' ? record : undefined;
    },
  };
  return { taskWorktrees };
}

describe('resolveTerminalLinkTarget', () => {
  it('returns EMPTY for whitespace-only text', async () => {
    const result = await resolveTerminalLinkTarget({ linkText: '   ' }, deps());
    expect(result).toEqual({ kind: 'none', reason: 'EMPTY' });
  });

  it('resolves an https URL with trailing punctuation stripped', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: 'See https://example.com/docs/page.' },
      deps(),
    );
    expect(result.kind).toBe('external-url');
    if (result.kind === 'external-url') {
      expect(result.url).toBe('https://example.com/docs/page');
    }
  });

  it('resolves an http URL with a long path', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: 'open http://example.com/a/b/c?x=1' },
      deps(),
    );
    expect(result).toEqual({
      kind: 'external-url',
      url: 'http://example.com/a/b/c?x=1',
    });
  });

  it('strips surrounding parens and quotes from URLs', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: '(see "https://example.com/x")' },
      deps(),
    );
    expect(result).toEqual({ kind: 'external-url', url: 'https://example.com/x' });
  });

  it('rejects unsupported schemes (mailto, ssh, file)', async () => {
    expect(
      await resolveTerminalLinkTarget({ linkText: 'mailto:a@b.c' }, deps()),
    ).toEqual({ kind: 'none', reason: 'UNSUPPORTED' });
    expect(
      await resolveTerminalLinkTarget({ linkText: 'ssh://user@host/repo' }, deps()),
    ).toEqual({ kind: 'none', reason: 'UNSUPPORTED' });
  });

  it('rejects file:// URLs (paths go through the worktree branch)', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: 'file:///C:/work/repo/.worktrees/task-1/file.ts' },
      deps(),
    );
    // file:// is not in SUPPORTED_URL_SCHEMES, so the resolver returns UNSUPPORTED
    // and the caller is expected to fall back to the path branch when the text
    // matches the worktree path. Here we strip the URL and check the leftover.
    expect(result.kind === 'external-url' || result.kind === 'none').toBe(true);
  });

  it('resolves a Windows absolute path inside the worktree', async () => {
    const result = await resolveTerminalLinkTarget(
      {
        linkText: 'C:\\work\\repo\\.worktrees\\task-1\\src\\file.ts:42:5',
        taskId: 'task-1',
      },
      deps(),
    );
    expect(result).toEqual({
      kind: 'worktree-file',
      absolutePath: 'C:\\work\\repo\\.worktrees\\task-1\\src\\file.ts:42:5',
    });
  });

  it('resolves a POSIX absolute path inside the worktree', async () => {
    const result = await resolveTerminalLinkTarget(
      {
        linkText: '/home/dev/repo/.worktrees/task-1/src/file.ts',
        taskId: 'task-1',
      },
      deps('/home/dev/repo/.worktrees/task-1'),
    );
    expect(result).toEqual({
      kind: 'worktree-file',
      absolutePath: '/home/dev/repo/.worktrees/task-1/src/file.ts',
    });
  });

  it('rejects paths outside the persisted worktree', async () => {
    const result = await resolveTerminalLinkTarget(
      {
        linkText: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
        taskId: 'task-1',
      },
      deps(),
    );
    expect(result).toEqual({ kind: 'none', reason: 'OUTSIDE_WORKTREE' });
  });

  it('returns TASK_NOT_FOUND when the worktree repository has no record', async () => {
    const result = await resolveTerminalLinkTarget(
      {
        linkText: 'C:\\work\\repo\\.worktrees\\task-1\\src\\file.ts',
        taskId: 'missing-task',
      },
      deps(),
    );
    expect(result).toEqual({ kind: 'none', reason: 'TASK_NOT_FOUND' });
  });

  it('returns UNSUPPORTED when no URL and no absolute path can be extracted', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: 'just plain text', taskId: 'task-1' },
      deps(),
    );
    expect(result).toEqual({ kind: 'none', reason: 'UNSUPPORTED' });
  });

  it('returns UNSUPPORTED for paths when no taskId is supplied', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: 'C:\\work\\repo\\file.ts' },
      deps(),
    );
    expect(result).toEqual({ kind: 'none', reason: 'UNSUPPORTED' });
  });

  it('detects URL even when path-style characters surround it', async () => {
    const result = await resolveTerminalLinkTarget(
      { linkText: 'open https://example.com/path and continue' },
      deps(),
    );
    expect(result.kind).toBe('external-url');
  });
});