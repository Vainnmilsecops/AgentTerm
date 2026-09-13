import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MergeConflictFile } from '@agentterm/application';

import { GitCliTaskMergeConflictProbe } from './index';

async function withRepository(
  setup: (repositoryPath: string, worktreePath: string) => Promise<void>,
  test: (fixture: { repositoryPath: string; worktreePath: string }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-merge-conflict-'));
  const repositoryPath = join(directory, 'repository');
  const worktreePath = join(directory, 'worktree');

  try {
    initializeRepository(repositoryPath);
    writeFileSync(join(repositoryPath, '.gitignore'), '*.ignored\n');
    writeFileSync(join(repositoryPath, 'tracked.txt'), 'initial\n');
    commitAll(repositoryPath, 'Initial commit');
    runGit(repositoryPath, ['worktree', 'add', '--quiet', '-b', 'feature/conflict', worktreePath]);
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree not created at ${worktreePath}`);
    }
    await setup(repositoryPath, worktreePath);
    await test({
      repositoryPath,
      worktreePath,
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
    '-m',
    message,
  ]);
  return runGit(repositoryPath, ['rev-parse', 'HEAD']).trim();
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

function writeTrackedFile(repositoryPath: string, path: string, content: string): void {
  writeFileSync(join(repositoryPath, path), content);
}

function commitTrackedFile(
  repositoryPath: string,
  path: string,
  message: string,
  fileContent: string,
): string {
  writeTrackedFile(repositoryPath, path, fileContent);
  commitAll(repositoryPath, message);
  return runGit(repositoryPath, ['rev-parse', 'HEAD']).trim();
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

  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

describe('GitCliTaskMergeConflictProbe (integration)', () => {
  it('returns "clean" when HEAD is merge-clean against the persisted base ref', async () => {
    await withRepository(
      async (repo, worktree) => {
        writeTrackedFile(worktree, 'tracked.txt', 'feature edit');
        commitAll(worktree, 'feature touch');
        runGit(repo, ['merge', '--ff-only', 'feature/conflict']);
      },
      async ({ worktreePath }) => {
        const probe = new GitCliTaskMergeConflictProbe();
        const result = await probe.probeMergeConflicts({
          baseRef: 'main',
          headRef: 'HEAD',
          repositoryPath: worktreePath,
          worktreePath,
        });
        expect(result.kind).toBe('clean');
      },
    );
  }, 20_000);

  it('returns the conflicted file when HEAD diverges from the base ref', async () => {
    await withRepository(
      async (repo, worktree) => {
        commitTrackedFile(repo, 'tracked.txt', 'edit main', 'main-edit');
        writeTrackedFile(worktree, 'tracked.txt', 'feature-edit');
        commitAll(worktree, 'edit feature');
      },
      async ({ worktreePath }) => {
        const probe = new GitCliTaskMergeConflictProbe();
        const result = await probe.probeMergeConflicts({
          baseRef: 'main',
          headRef: 'HEAD',
          repositoryPath: worktreePath,
          worktreePath,
        });
        expect(result.kind).toBe('conflicts');
        if (result.kind !== 'conflicts') return;
        expect(result.files.length).toBeGreaterThan(0);
        const paths = result.files.map((file: MergeConflictFile) => file.path);
        expect(paths).toContain('tracked.txt');
      },
    );
  }, 20_000);

  it('returns NO_BASE_REF when the base ref name does not resolve', async () => {
    await withRepository(
      async () => undefined,
      async ({ worktreePath }) => {
        const probe = new GitCliTaskMergeConflictProbe();
        const result = await probe.probeMergeConflicts({
          baseRef: 'refs/heads/does-not-exist',
          headRef: 'HEAD',
          repositoryPath: worktreePath,
          worktreePath,
        });
        expect(result.kind).toBe('unavailable');
        if (result.kind !== 'unavailable') return;
        expect(result.reason).toBe('NO_BASE_REF');
      },
    );
  }, 20_000);
});
