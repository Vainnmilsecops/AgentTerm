import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTask, ensureTaskWorktree } from '@agentterm/application';
import { createProject } from '@agentterm/domain';

import { GitCliTaskWorktreeLifecycle, openSqlitePersistence } from './index';

describe('GitCliTaskWorktreeLifecycle change inspection', () => {
  it('lists and diffs staged, unstaged, renamed, deleted, untracked, binary, and large changes only in the Task Worktree', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentterm-task-changes-'));
    const repositoryPath = join(fixtureRoot, 'Repository');
    const worktreesRoot = join(fixtureRoot, 'Task Worktrees');
    const databasePath = join(fixtureRoot, 'agentterm.db');
    initializeRepository(repositoryPath);
    for (const [path, content] of [
      ['modified.txt', 'before\n'],
      ['deleted.txt', 'delete me\n'],
      ['old-name.txt', 'rename me\n'],
      ['binary.dat', Buffer.from([0, 1, 2, 3])],
      ['large.txt', 'small\n'],
    ] as const) {
      writeFileSync(join(repositoryPath, path), content);
    }
    commitAll(repositoryPath, 'Initial fixture');
    const canonicalRepositoryPath = realpathSync.native(repositoryPath);
    const persistence = openSqlitePersistence(databasePath);

    try {
      await persistence.projects.recordOpen({
        pathIdentity: `test:${canonicalRepositoryPath.toLocaleLowerCase('en-US')}`,
        project: createProject({ id: 'project-changes', name: 'Change fixture' }),
        rootPath: canonicalRepositoryPath,
      });
      await createTask(
        { id: 'task-changes', projectId: 'project-changes', title: 'Inspect real changes' },
        persistence.projects,
        persistence.tasks,
      );
      const inspector = new GitCliTaskWorktreeLifecycle(worktreesRoot);
      const ensured = await ensureTaskWorktree(
        { taskId: 'task-changes' },
        persistence.tasks,
        persistence.projects,
        persistence.worktrees,
        inspector,
      );
      const recorded = await persistence.worktrees.findByTaskId('task-changes');
      if (recorded === undefined) throw new Error('Fixture Worktree was not persisted.');

      writeFileSync(join(canonicalRepositoryPath, 'modified.txt'), 'main-tree decoy\n');
      await expect(inspector.listChanges(recorded)).resolves.toEqual({
        files: [],
        totalFiles: 0,
        truncated: false,
      });

      const taskWorktreePath = ensured.worktree.worktreePath;
      writeFileSync(join(taskWorktreePath, 'committed.txt'), 'committed Task change\n');
      commitAll(taskWorktreePath, 'Committed Task change');
      writeFileSync(join(taskWorktreePath, 'modified.txt'), 'after\n');
      unlinkSync(join(taskWorktreePath, 'deleted.txt'));
      writeFileSync(join(taskWorktreePath, 'added.txt'), 'new staged file\n');
      runGit(taskWorktreePath, ['add', '--', 'added.txt']);
      runGit(taskWorktreePath, ['mv', '--', 'old-name.txt', 'renamed.txt']);
      writeFileSync(join(taskWorktreePath, 'notes.txt'), 'untracked evidence\n');
      writeFileSync(join(taskWorktreePath, 'binary.dat'), Buffer.from([0, 9, 8, 7]));
      writeFileSync(join(taskWorktreePath, 'large.txt'), 'x'.repeat(200 * 1024));
      const statusBefore = readStatus(taskWorktreePath);

      const changes = await inspector.listChanges(recorded);

      expect(changes).toMatchObject({ totalFiles: 8, truncated: false });
      expect(changes.files).toEqual(
        expect.arrayContaining([
          { area: 'COMMITTED', kind: 'ADDED', path: 'committed.txt' },
          { area: 'STAGED', kind: 'ADDED', path: 'added.txt' },
          {
            area: 'STAGED',
            kind: 'RENAMED',
            path: 'renamed.txt',
            previousPath: 'old-name.txt',
          },
          { area: 'UNSTAGED', kind: 'DELETED', path: 'deleted.txt' },
          { area: 'UNSTAGED', kind: 'MODIFIED', path: 'modified.txt' },
          { area: 'UNSTAGED', kind: 'MODIFIED', path: 'binary.dat' },
          { area: 'UNSTAGED', kind: 'MODIFIED', path: 'large.txt' },
          { area: 'UNTRACKED', kind: 'UNTRACKED', path: 'notes.txt' },
        ]),
      );
      expect(changes.files.some(({ path }) => path.includes('main-tree'))).toBe(false);

      await expect(
        inspector.getFileDiff(recorded, { area: 'COMMITTED', path: 'committed.txt' }),
      ).resolves.toMatchObject({
        additions: 1,
        area: 'COMMITTED',
        deletions: 0,
        kind: 'ADDED',
        patch: { text: expect.stringContaining('+committed Task change'), truncated: false },
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNSTAGED', path: 'modified.txt' }),
      ).resolves.toMatchObject({
        additions: 1,
        area: 'UNSTAGED',
        binary: false,
        deletions: 1,
        kind: 'MODIFIED',
        patch: { truncated: false },
        path: 'modified.txt',
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'STAGED', path: 'added.txt' }),
      ).resolves.toMatchObject({
        additions: 1,
        area: 'STAGED',
        binary: false,
        deletions: 0,
        kind: 'ADDED',
        patch: { text: expect.stringContaining('+new staged file'), truncated: false },
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNSTAGED', path: 'deleted.txt' }),
      ).resolves.toMatchObject({ additions: 0, deletions: 1, kind: 'DELETED' });
      await expect(
        inspector.getFileDiff(recorded, {
          area: 'STAGED',
          path: 'renamed.txt',
          previousPath: 'old-name.txt',
        }),
      ).resolves.toMatchObject({
        additions: 0,
        deletions: 0,
        kind: 'RENAMED',
        previousPath: 'old-name.txt',
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNTRACKED', path: 'notes.txt' }),
      ).resolves.toMatchObject({
        additions: 1,
        binary: false,
        deletions: 0,
        kind: 'UNTRACKED',
        patch: { text: expect.stringContaining('+untracked evidence'), truncated: false },
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNSTAGED', path: 'binary.dat' }),
      ).resolves.toMatchObject({
        binary: true,
        omittedReason: 'BINARY',
        patch: undefined,
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNSTAGED', path: 'large.txt' }),
      ).resolves.toMatchObject({
        binary: false,
        omittedReason: 'TOO_LARGE',
        patch: undefined,
      });
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNSTAGED', path: '../outside.txt' }),
      ).rejects.toMatchObject({ name: 'TaskChangeInspectionError', reason: 'CHANGE_NOT_FOUND' });

      writeFileSync(join(taskWorktreePath, 'large-untracked.txt'), 'u'.repeat(200 * 1024));
      await expect(
        inspector.getFileDiff(recorded, { area: 'UNTRACKED', path: 'large-untracked.txt' }),
      ).resolves.toMatchObject({
        additions: undefined,
        binary: undefined,
        deletions: undefined,
        omittedReason: 'TOO_LARGE',
        patch: undefined,
      });
      unlinkSync(join(taskWorktreePath, 'large-untracked.txt'));
      expect(readStatus(taskWorktreePath)).toBe(statusBefore);

      const bulkDirectory = join(taskWorktreePath, 'bulk');
      mkdirSync(bulkDirectory);
      for (let index = 0; index < 505; index += 1) {
        writeFileSync(join(bulkDirectory, `${index.toString().padStart(3, '0')}.txt`), 'bounded\n');
      }
      await expect(inspector.listChanges(recorded)).resolves.toMatchObject({
        files: { length: 500 },
        totalFiles: 513,
        truncated: true,
      });
    } finally {
      persistence.close();
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }, 30_000);
});

function initializeRepository(repositoryPath: string): void {
  execFileSync('git', ['init', '--initial-branch=main', '--quiet', repositoryPath], {
    cwd: dirname(process.execPath),
    env: createTestGitEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
  runGit(repositoryPath, ['config', 'core.autocrlf', 'false']);
}

function commitAll(repositoryPath: string, message: string): void {
  runGit(repositoryPath, ['add', '--all']);
  runGit(repositoryPath, [
    '-c',
    'user.name=AgentTerm Tests',
    '-c',
    'user.email=agentterm-tests@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    message,
  ]);
}

function readStatus(repositoryPath: string): string {
  return runGit(repositoryPath, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--find-renames',
  ]);
}

function runGit(repositoryPath: string, arguments_: readonly string[]): string {
  return execFileSync(
    'git',
    [
      '--no-pager',
      '--no-optional-locks',
      '-C',
      repositoryPath,
      '-c',
      'core.autocrlf=false',
      ...arguments_,
    ],
    {
      cwd: dirname(process.execPath),
      encoding: 'utf8',
      env: createTestGitEnvironment(),
      windowsHide: true,
    },
  );
}

function createTestGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowedNames = new Set([
    'APPDATA',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]);
  for (const [name, value] of Object.entries(process.env)) {
    if (allowedNames.has(name.toUpperCase()) && value !== undefined) environment[name] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}
