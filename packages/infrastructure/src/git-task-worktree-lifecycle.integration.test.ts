import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  cleanupTaskWorktree,
  createTask,
  ensureTaskWorktree,
  inspectTaskWorktree,
} from '@agentterm/application';
import { createProject } from '@agentterm/domain';

import {
  GitCliTaskWorktreeLifecycle,
  openSqlitePersistence,
  type SqlitePersistence,
} from './index';

interface GitFixture {
  readonly baseCommitId: string;
  readonly databasePath: string;
  readonly repositoryPath: string;
  readonly worktreesRoot: string;
}

interface PersistedWorktreeRow {
  readonly branchName: string;
  readonly lifecycleState: string;
  readonly worktreePath: string;
}

const projectId = 'project-1';

async function withGitFixture(run: (fixture: GitFixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-task-worktree-'));
  const repositoryPath = join(directory, 'Repository With Spaces');
  const worktreesRoot = join(directory, 'Task Worktrees');
  const databasePath = join(directory, 'agentterm.db');

  try {
    initializeRepository(repositoryPath);
    writeFileSync(join(repositoryPath, '.gitignore'), '*.ignored\n');
    writeFileSync(join(repositoryPath, 'tracked.txt'), 'initial\n');
    const baseCommitId = commitAll(repositoryPath, 'Initial commit');
    await run({
      baseCommitId,
      databasePath,
      repositoryPath: realpathSync.native(repositoryPath),
      worktreesRoot,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function initializeRepository(repositoryPath: string): void {
  execFileSync('git', ['init', '--initial-branch=main', '--quiet', repositoryPath], {
    cwd: dirname(process.execPath),
    env: createTestGitEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function commitAll(repositoryPath: string, message: string): string {
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
  return removeFinalLineEnding(runGit(repositoryPath, ['rev-parse', 'HEAD']));
}

function runGit(repositoryPath: string, arguments_: readonly string[]): string {
  return execFileSync(
    'git',
    ['--no-optional-locks', '-C', repositoryPath, '-c', 'core.autocrlf=false', ...arguments_],
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
    if (allowedNames.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }

  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function removeFinalLineEnding(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }

  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

async function registerProjectAndTasks(
  persistence: SqlitePersistence,
  repositoryPath: string,
  taskIds: readonly string[],
): Promise<void> {
  await persistence.projects.recordOpen({
    pathIdentity: `test:${repositoryPath.toLocaleLowerCase('en-US')}`,
    project: createProject({ id: projectId, name: 'AgentTerm fixture' }),
    rootPath: repositoryPath,
  });

  for (const taskId of taskIds) {
    await createTask(
      { id: taskId, projectId, title: `Worktree for ${taskId}` },
      persistence.projects,
      persistence.tasks,
    );
  }
}

function countRegisteredWorktrees(repositoryPath: string): number {
  return runGit(repositoryPath, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((record) => record.startsWith('worktree ')).length;
}

function expectWindowsSafeSegment(segment: string): void {
  expect(segment).not.toMatch(/[<>:"/\\|?*]/u);
  expect([...segment].some((character) => character.charCodeAt(0) <= 0x1f)).toBe(false);
  expect(segment).not.toMatch(/[ .]$/u);
  expect(segment).not.toMatch(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu);
}

function removeFixtureWorktreeDirectory(worktreesRoot: string, worktreePath: string): void {
  const relativePath = relative(worktreesRoot, worktreePath);

  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error('Refusing to remove a Worktree outside the test fixture root.');
  }

  rmSync(worktreePath, { force: true, recursive: true });
}

function readPersistedWorktree(databasePath: string, taskId: string): PersistedWorktreeRow {
  const database = new DatabaseSync(databasePath, { readOnly: true });

  try {
    const row = database
      .prepare(
        `SELECT branch_name, lifecycle_state, worktree_path
         FROM task_worktrees
         WHERE task_id = ?`,
      )
      .get(taskId);

    if (
      row === undefined ||
      typeof row.branch_name !== 'string' ||
      typeof row.lifecycle_state !== 'string' ||
      typeof row.worktree_path !== 'string'
    ) {
      throw new Error(`Missing persisted Worktree for ${taskId}.`);
    }

    return {
      branchName: row.branch_name,
      lifecycleState: row.lifecycle_state,
      worktreePath: row.worktree_path,
    };
  } finally {
    database.close();
  }
}

function installPresentTransitionFailure(databasePath: string): void {
  const database = new DatabaseSync(databasePath);

  try {
    database.exec(`
      CREATE TRIGGER fail_task_worktree_present
      BEFORE UPDATE OF lifecycle_state ON task_worktrees
      WHEN OLD.lifecycle_state = 'PROVISIONING'
       AND NEW.lifecycle_state = 'PRESENT'
      BEGIN
        SELECT RAISE(ABORT, 'injected PRESENT transition failure');
      END;
    `);
  } finally {
    database.close();
  }
}

function removePresentTransitionFailure(databasePath: string): void {
  const database = new DatabaseSync(databasePath);

  try {
    database.exec('DROP TRIGGER fail_task_worktree_present');
  } finally {
    database.close();
  }
}

function installRemovedTransitionFailure(databasePath: string): void {
  const database = new DatabaseSync(databasePath);

  try {
    database.exec(`
      CREATE TRIGGER fail_task_worktree_removed
      BEFORE UPDATE OF lifecycle_state ON task_worktrees
      WHEN OLD.lifecycle_state = 'REMOVING'
       AND NEW.lifecycle_state = 'REMOVED'
      BEGIN
        SELECT RAISE(ABORT, 'injected REMOVED transition failure');
      END;
    `);
  } finally {
    database.close();
  }
}

function removeRemovedTransitionFailure(databasePath: string): void {
  const database = new DatabaseSync(databasePath);

  try {
    database.exec('DROP TRIGGER fail_task_worktree_removed');
  } finally {
    database.close();
  }
}

describe('Git task Worktree lifecycle with SQLite', { timeout: 30_000 }, () => {
  it('creates a Task branch and Worktree, then persists verified PRESENT metadata', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = 'task-create';
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);

        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        expect(created).toMatchObject({
          kind: 'created',
          status: {
            conflictedPaths: [],
            ignoredPaths: [],
            isDirty: false,
            stagedPaths: [],
            unstagedPaths: [],
            untrackedPaths: [],
          },
          worktree: {
            baseCommitId: fixture.baseCommitId,
            baseRefName: 'refs/heads/main',
            repositoryRootPath: fixture.repositoryPath,
            taskId,
          },
        });
        expect(created.worktree.branchName.trim()).not.toBe('');
        expect(created.worktree.pathIdentity.trim()).not.toBe('');
        expect(existsSync(created.worktree.worktreePath)).toBe(true);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
        expect(
          removeFinalLineEnding(
            runGit(fixture.repositoryPath, [
              'show-ref',
              '--verify',
              '--hash',
              `refs/heads/${created.worktree.branchName}`,
            ]),
          ),
        ).toBe(fixture.baseCommitId);

        const inspected = await inspectTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        expect(inspected).toMatchObject({
          actual: {
            kind: 'present',
            status: { ignoredPaths: [], isDirty: false },
            worktree: created.worktree,
          },
          persistedState: 'PRESENT',
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('reuses the exact persisted Worktree after reopening SQLite instead of adding one', async () => {
    await withGitFixture(async (fixture) => {
      const taskId = 'task-restart';
      let persistence = openSqlitePersistence(fixture.databasePath);
      let firstWorktree: Awaited<ReturnType<typeof ensureTaskWorktree>>['worktree'];

      try {
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
        );
        firstWorktree = created.worktree;
      } finally {
        persistence.close();
      }

      const countBeforeRetry = countRegisteredWorktrees(fixture.repositoryPath);
      persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const retried = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
        );

        expect(retried.kind).toBe('reused');
        expect(retried.worktree).toEqual(firstWorktree);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(countBeforeRetry);
      } finally {
        persistence.close();
      }
    });
  });

  it('uses distinct deterministic Windows-safe names for adversarial colliding Task ids', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskIds = ['CON: Fix/Alpha?', 'CON* Fix\\Alpha|'] as const;
        await registerProjectAndTasks(persistence, fixture.repositoryPath, taskIds);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const first = await ensureTaskWorktree(
          { taskId: taskIds[0] },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );
        const second = await ensureTaskWorktree(
          { taskId: taskIds[1] },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        expect(second.worktree.branchName).not.toBe(first.worktree.branchName);
        expect(second.worktree.worktreePath).not.toBe(first.worktree.worktreePath);
        expect(second.worktree.pathIdentity).not.toBe(first.worktree.pathIdentity);

        for (const result of [first, second]) {
          expect(() =>
            runGit(fixture.repositoryPath, [
              'check-ref-format',
              '--branch',
              result.worktree.branchName,
            ]),
          ).not.toThrow();
          for (const segment of result.worktree.branchName.split('/')) {
            expectWindowsSafeSegment(segment);
          }
          expectWindowsSafeSegment(basename(result.worktree.worktreePath));
          const relativePath = relative(
            realpathSync.native(fixture.worktreesRoot),
            realpathSync.native(result.worktree.worktreePath),
          );
          expect(isAbsolute(relativePath)).toBe(false);
          expect(relativePath).not.toBe('..');
          expect(relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)).toBe(
            false,
          );
        }

        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(3);
      } finally {
        persistence.close();
      }
    });
  });

  it('preserves an unregistered directory that occupies the deterministic Worktree path', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = 'task-path-collision';
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const planned = await lifecycle.inspect({
          repositoryRootPath: fixture.repositoryPath,
          taskId,
        });

        expect(planned.kind).toBe('missing');
        mkdirSync(planned.worktree.worktreePath);
        const markerPath = join(planned.worktree.worktreePath, 'user-data.txt');
        writeFileSync(markerPath, 'preserve me\n');

        await expect(
          ensureTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).rejects.toMatchObject({
          name: 'TaskWorktreeLifecycleError',
          reason: 'PATH_COLLISION',
        });

        expect(readFileSync(markerPath, 'utf8')).toBe('preserve me\n');
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(1);
        await expect(persistence.worktrees.findByTaskId(taskId)).resolves.toBeUndefined();
      } finally {
        persistence.close();
      }
    });
  });

  it('refuses a deterministic Task branch already checked out at another path', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = 'task-branch-collision';
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const planned = await lifecycle.inspect({
          repositoryRootPath: fixture.repositoryPath,
          taskId,
        });
        const otherPath = join(fixture.worktreesRoot, 'occupied-elsewhere');

        runGit(fixture.repositoryPath, [
          'branch',
          '--no-track',
          planned.worktree.branchName,
          fixture.baseCommitId,
        ]);
        runGit(fixture.repositoryPath, ['worktree', 'add', otherPath, planned.worktree.branchName]);

        await expect(
          ensureTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).rejects.toMatchObject({
          name: 'TaskWorktreeLifecycleError',
          reason: 'BRANCH_COLLISION',
        });

        expect(existsSync(otherPath)).toBe(true);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
        await expect(persistence.worktrees.findByTaskId(taskId)).resolves.toBeUndefined();
        runGit(fixture.repositoryPath, ['worktree', 'remove', otherPath]);
      } finally {
        persistence.close();
      }
    });
  });

  it.each([
    {
      content: 'tracked user edit\n',
      label: 'tracked changes',
      relativePath: 'tracked.txt',
    },
    {
      content: 'untracked user file\n',
      label: 'untracked files',
      relativePath: 'draft.txt',
    },
    {
      content: 'ignored but valuable\n',
      label: 'ignored files',
      relativePath: 'notes.ignored',
    },
  ])('refuses cleanup for $label and preserves the file and registration', async (dirtyCase) => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = `task-dirty-${dirtyCase.relativePath}`;
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );
        const protectedPath = join(created.worktree.worktreePath, dirtyCase.relativePath);
        writeFileSync(protectedPath, dirtyCase.content);

        await expect(
          cleanupTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).rejects.toMatchObject({
          name: 'TaskWorktreeLifecycleError',
          reason: 'DIRTY_WORKTREE',
        });

        expect(readFileSync(protectedPath, 'utf8')).toBe(dirtyCase.content);
        expect(existsSync(created.worktree.worktreePath)).toBe(true);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
        await expect(
          inspectTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).resolves.toMatchObject({
          actual: { kind: 'present' },
          persistedState: 'PRESENT',
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('removes a clean Worktree while preserving its Task branch and REMOVED metadata', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = 'task-cleanup';
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        const removed = await cleanupTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        expect(removed).toEqual({ kind: 'removed', worktree: created.worktree });
        expect(existsSync(created.worktree.worktreePath)).toBe(false);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(1);
        expect(
          removeFinalLineEnding(
            runGit(fixture.repositoryPath, [
              'show-ref',
              '--verify',
              '--hash',
              `refs/heads/${created.worktree.branchName}`,
            ]),
          ),
        ).toBe(fixture.baseCommitId);
        await expect(
          inspectTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).resolves.toMatchObject({
          actual: { kind: 'missing', worktree: created.worktree },
          persistedState: 'REMOVED',
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('cleans an exact stale registration after external directory loss without deleting the Task branch', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = 'task-stale-registration';
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        removeFixtureWorktreeDirectory(fixture.worktreesRoot, created.worktree.worktreePath);

        await expect(
          inspectTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).resolves.toMatchObject({
          actual: { kind: 'stale-registration', worktree: created.worktree },
          persistedState: 'PRESENT',
        });

        await expect(
          cleanupTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          ),
        ).resolves.toEqual({ kind: 'removed', worktree: created.worktree });

        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(1);
        expect(
          removeFinalLineEnding(
            runGit(fixture.repositoryPath, [
              'show-ref',
              '--verify',
              '--hash',
              `refs/heads/${created.worktree.branchName}`,
            ]),
          ),
        ).toBe(fixture.baseCommitId);
        expect(readPersistedWorktree(fixture.databasePath, taskId).lifecycleState).toBe('REMOVED');
      } finally {
        persistence.close();
      }
    });
  });

  it('recreates an exact stale Worktree from its preserved deterministic branch on retry', async () => {
    await withGitFixture(async (fixture) => {
      const persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const taskId = 'task-stale-retry';
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        removeFixtureWorktreeDirectory(fixture.worktreesRoot, created.worktree.worktreePath);

        const retried = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          lifecycle,
        );

        expect(retried.kind).toBe('created');
        expect(retried.worktree).toEqual(created.worktree);
        expect(existsSync(retried.worktree.worktreePath)).toBe(true);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
        expect(readPersistedWorktree(fixture.databasePath, taskId).lifecycleState).toBe('PRESENT');
      } finally {
        persistence.close();
      }
    });
  });

  it.each(['cleanup', 'ensure'] as const)(
    'refuses %s when a stale registration still has recoverable staged changes',
    async (operation) => {
      await withGitFixture(async (fixture) => {
        const persistence = openSqlitePersistence(fixture.databasePath);

        try {
          const taskId = `task-stale-staged-${operation}`;
          await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
          const lifecycle = new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot);
          const created = await ensureTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            lifecycle,
          );
          const stagedContent = `recoverable ${operation} change\n`;
          writeFileSync(join(created.worktree.worktreePath, 'tracked.txt'), stagedContent);
          runGit(created.worktree.worktreePath, ['add', 'tracked.txt']);
          const recoveryPath = realpathSync.native(
            removeFinalLineEnding(
              runGit(created.worktree.worktreePath, [
                'rev-parse',
                '--path-format=absolute',
                '--git-dir',
              ]),
            ),
          );

          removeFixtureWorktreeDirectory(fixture.worktreesRoot, created.worktree.worktreePath);

          const attempted =
            operation === 'cleanup'
              ? cleanupTaskWorktree(
                  { taskId },
                  persistence.tasks,
                  persistence.projects,
                  persistence.worktrees,
                  lifecycle,
                )
              : ensureTaskWorktree(
                  { taskId },
                  persistence.tasks,
                  persistence.projects,
                  persistence.worktrees,
                  lifecycle,
                );

          await expect(attempted).rejects.toMatchObject({
            name: 'TaskWorktreeLifecycleError',
            reason: 'DIRTY_WORKTREE',
            recoveryPath,
            status: {
              isDirty: true,
              stagedPaths: ['tracked.txt'],
            },
          });
          expect(existsSync(join(recoveryPath, 'index'))).toBe(true);
          expect(
            runGit(fixture.repositoryPath, [
              `--git-dir=${recoveryPath}`,
              `--work-tree=${created.worktree.worktreePath}`,
              'show',
              ':tracked.txt',
            ]),
          ).toBe(stagedContent);
          expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
          expect(readPersistedWorktree(fixture.databasePath, taskId).lifecycleState).toBe(
            'PRESENT',
          );
        } finally {
          persistence.close();
        }
      });
    },
  );

  it('keeps PROVISIONING after Git succeeds but PRESENT persistence fails, then reconciles', async () => {
    await withGitFixture(async (fixture) => {
      const taskId = 'task-reconcile';
      let persistence = openSqlitePersistence(fixture.databasePath);

      try {
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
      } finally {
        persistence.close();
      }

      installPresentTransitionFailure(fixture.databasePath);
      persistence = openSqlitePersistence(fixture.databasePath);

      try {
        await expect(
          ensureTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
          ),
        ).rejects.toMatchObject({ name: 'TaskWorktreePersistenceError' });

        const provisioning = readPersistedWorktree(fixture.databasePath, taskId);
        expect(provisioning.lifecycleState).toBe('PROVISIONING');
        expect(existsSync(provisioning.worktreePath)).toBe(true);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
      } finally {
        persistence.close();
      }

      const beforeRetry = readPersistedWorktree(fixture.databasePath, taskId);
      removePresentTransitionFailure(fixture.databasePath);
      persistence = openSqlitePersistence(fixture.databasePath);

      try {
        const reconciled = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
        );

        expect(reconciled.kind).toBe('reused');
        expect(reconciled.worktree.worktreePath).toBe(beforeRetry.worktreePath);
        expect(reconciled.worktree.branchName).toBe(beforeRetry.branchName);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(2);
        await expect(
          inspectTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
          ),
        ).resolves.toMatchObject({
          actual: { kind: 'present', worktree: reconciled.worktree },
          persistedState: 'PRESENT',
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('keeps REMOVING after cleanup succeeds but REMOVED persistence fails, then reconciles', async () => {
    await withGitFixture(async (fixture) => {
      const taskId = 'task-cleanup-reconcile';
      let persistence = openSqlitePersistence(fixture.databasePath);
      let worktreePath: string;
      let branchName: string;

      try {
        await registerProjectAndTasks(persistence, fixture.repositoryPath, [taskId]);
        const created = await ensureTaskWorktree(
          { taskId },
          persistence.tasks,
          persistence.projects,
          persistence.worktrees,
          new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
        );
        worktreePath = created.worktree.worktreePath;
        branchName = created.worktree.branchName;
      } finally {
        persistence.close();
      }

      installRemovedTransitionFailure(fixture.databasePath);
      persistence = openSqlitePersistence(fixture.databasePath);

      try {
        await expect(
          cleanupTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
          ),
        ).rejects.toMatchObject({
          gitState: 'REMOVED',
          name: 'TaskWorktreePersistenceError',
        });

        expect(readPersistedWorktree(fixture.databasePath, taskId).lifecycleState).toBe('REMOVING');
        expect(existsSync(worktreePath)).toBe(false);
        expect(countRegisteredWorktrees(fixture.repositoryPath)).toBe(1);
        expect(() =>
          runGit(fixture.repositoryPath, ['show-ref', '--verify', `refs/heads/${branchName}`]),
        ).not.toThrow();
      } finally {
        persistence.close();
      }

      removeRemovedTransitionFailure(fixture.databasePath);
      persistence = openSqlitePersistence(fixture.databasePath);

      try {
        await expect(
          cleanupTaskWorktree(
            { taskId },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            new GitCliTaskWorktreeLifecycle(fixture.worktreesRoot),
          ),
        ).resolves.toMatchObject({ kind: 'already-missing' });
        expect(readPersistedWorktree(fixture.databasePath, taskId).lifecycleState).toBe('REMOVED');
      } finally {
        persistence.close();
      }
    });
  });
});
