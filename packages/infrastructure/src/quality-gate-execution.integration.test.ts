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
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ensureTaskWorktree,
  runQualityGate,
  type QualityGateCatalog,
} from '@agentterm/application';
import { createProject, createQualityGate, createTask, QualityGateKind } from '@agentterm/domain';

import {
  GitCliTaskWorktreeLifecycle,
  NodeQualityGateProcessRunner,
  openSqlitePersistence,
} from './index';

describe('Quality Gate execution in a real Task Worktree', () => {
  it.runIf(process.platform === 'win32')(
    'runs only in the verified primary Worktree and preserves dirty user work and history',
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentterm-gate-worktree-'));
      const repositoryPath = join(fixtureRoot, 'Repository With Spaces');
      const worktreesRoot = join(fixtureRoot, 'Task Worktrees');
      const databasePath = join(fixtureRoot, 'agentterm.db');

      try {
        initializeRepository(repositoryPath);
        writeFileSync(join(repositoryPath, 'tracked.txt'), 'initial\n', 'utf8');
        commitAll(repositoryPath);
        const canonicalRepositoryPath = realpathSync.native(repositoryPath);
        const persistence = openSqlitePersistence(databasePath);
        const task = createTask({
          id: 'task-quality-gate',
          projectId: 'project-quality-gate',
          title: 'Ki\u1ec3m tra trong Worktree',
        });

        try {
          await persistence.projects.recordOpen({
            pathIdentity: `test:${canonicalRepositoryPath.toLocaleLowerCase('en-US')}`,
            project: createProject({ id: task.projectId, name: 'Quality Gate fixture' }),
            rootPath: canonicalRepositoryPath,
          });
          await persistence.tasks.insert(task);

          const git = new GitCliTaskWorktreeLifecycle(worktreesRoot);
          const ensured = await ensureTaskWorktree(
            { taskId: task.id },
            persistence.tasks,
            persistence.projects,
            persistence.worktrees,
            git,
          );
          expect(ensured.kind).toBe('created');
          expect(countRegisteredWorktrees(canonicalRepositoryPath)).toBe(2);

          writeFileSync(
            join(ensured.worktree.worktreePath, 'tracked.txt'),
            'agent commit\n',
            'utf8',
          );
          commitAll(ensured.worktree.worktreePath);
          const headCommitIdAtStart = runGit(ensured.worktree.worktreePath, [
            'rev-parse',
            'HEAD',
          ]).trim();
          expect(headCommitIdAtStart).not.toBe(ensured.worktree.baseCommitId);

          const userFile = join(ensured.worktree.worktreePath, 'user-notes.txt');
          const gateFile = join(ensured.worktree.worktreePath, 'gate-cwd.txt');
          writeFileSync(
            userFile,
            'Gi\u1eef nguy\u00ean thay \u0111\u1ed5i c\u1ee7a ng\u01b0\u1eddi d\u00f9ng\n',
            'utf8',
          );

          const gate = createQualityGate({
            command: {
              arguments: [
                '-e',
                `const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(process.cwd(), 'gate-cwd.txt'), process.cwd(), 'utf8'); process.stdout.write('CWD:' + process.cwd() + '\\n');`,
              ],
              executablePath: process.execPath,
            },
            id: 'test',
            kind: QualityGateKind.TEST,
            timeoutMs: 5_000,
          });
          const gates: QualityGateCatalog = {
            findById: async (id) => (id === gate.id ? gate : undefined),
            list: async () => [gate],
            register: async () => undefined,
            unregister: async () => false,
          };

          const run = await runQualityGate(
            {
              environment: {},
              gateId: gate.id,
              runId: 'gate-run-1',
              taskId: task.id,
            },
            {
              clock: sequenceClock(1_800_000_000_000, 1_800_000_000_025),
              gates,
              git,
              localProjects: persistence.projects,
              maxOutputBytes: 262_144,
              processRunner: new NodeQualityGateProcessRunner(),
              runs: persistence.qualityGateRuns,
              tasks: persistence.tasks,
              worktrees: persistence.worktrees,
            },
          );

          expect(run).toMatchObject({
            status: 'PASSED',
            worktree: {
              baseCommitId: ensured.worktree.baseCommitId,
              headCommitIdAtStart,
              pathIdentity: ensured.worktree.pathIdentity,
              worktreePath: ensured.worktree.worktreePath,
            },
          });
          expect(run.output?.text).toContain(`CWD:${ensured.worktree.worktreePath}`);
          expect(readFileSync(userFile, 'utf8')).toBe(
            'Gi\u1eef nguy\u00ean thay \u0111\u1ed5i c\u1ee7a ng\u01b0\u1eddi d\u00f9ng\n',
          );
          expect(readFileSync(gateFile, 'utf8')).toBe(ensured.worktree.worktreePath);
          expect(existsSync(join(canonicalRepositoryPath, 'gate-cwd.txt'))).toBe(false);
          expect(countRegisteredWorktrees(canonicalRepositoryPath)).toBe(2);
          await expect(persistence.qualityGateRuns.listByTaskId(task.id)).resolves.toEqual([run]);
          await expect(persistence.tasks.findById(task.id)).resolves.toEqual(task);

          const recordedWorktree = await persistence.worktrees.findByTaskId(task.id);
          expect(recordedWorktree).toBeDefined();
          const inspected = await git.inspect({
            ...(recordedWorktree === undefined ? {} : { recordedWorktree }),
            repositoryRootPath: canonicalRepositoryPath,
            taskId: task.id,
          });
          expect(inspected).toMatchObject({
            kind: 'present',
            status: {
              isDirty: true,
              untrackedPaths: expect.arrayContaining(['gate-cwd.txt', 'user-notes.txt']),
            },
          });
        } finally {
          persistence.close();
        }
      } finally {
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
    20_000,
  );
});

function initializeRepository(repositoryPath: string): void {
  mkdirSync(repositoryPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', '--quiet', repositoryPath], {
    cwd: dirname(process.execPath),
    env: createTestGitEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function commitAll(repositoryPath: string): void {
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
    'Initial commit',
  ]);
}

function runGit(repositoryPath: string, arguments_: readonly string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', repositoryPath, ...arguments_], {
    cwd: dirname(process.execPath),
    encoding: 'utf8',
    env: createTestGitEnvironment(),
    windowsHide: true,
  });
}

function countRegisteredWorktrees(repositoryPath: string): number {
  return runGit(repositoryPath, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((record) => record.startsWith('worktree ')).length;
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

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
