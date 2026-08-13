import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TaskWorktreeRecord } from '@agentterm/application';

import { GitHubPullRequestAdapter } from './index';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('GitHub Pull Request adapter with real Git', () => {
  it.each([
    ['HTTPS', 'https://github.com/octo-org/sample.git'],
    ['SSH scp', 'git@github.com:octo-org/sample.git'],
    ['SSH URL', 'ssh://git@github.com/octo-org/sample.git'],
  ])(
    'detects a %s GitHub repository and exact Task branch readiness',
    async (_label, remoteUrl) => {
      const fixture = createRepository(remoteUrl, true);
      const adapter = new GitHubPullRequestAdapter('git', join(fixture.root, 'missing-gh.exe'));

      await expect(adapter.inspect(fixture.worktree)).resolves.toEqual({
        baseBranch: 'main',
        githubAuthenticationAvailable: false,
        githubCliAvailable: false,
        headBranch: 'agentterm/task/pr-ready',
        headCommitId: fixture.headCommitId,
        kind: 'ready',
        provider: 'github',
        pullRequest: undefined,
        remoteHeadCommitId: undefined,
        remoteName: 'origin',
        repositoryName: 'sample',
        repositoryOwner: 'octo-org',
      });
    },
    15_000,
  );

  it('blocks non-GitHub remotes, mismatched branches, detached HEAD, and branches with no commits', async () => {
    const nonGithub = createRepository('https://example.com/octo-org/sample.git', true);
    const adapter = new GitHubPullRequestAdapter('git', join(nonGithub.root, 'missing-gh.exe'));
    await expect(adapter.inspect(nonGithub.worktree)).resolves.toEqual({
      kind: 'blocked',
      reason: 'GITHUB_REMOTE_NOT_FOUND',
    });

    const mismatch = createRepository('https://github.com/octo-org/sample.git', true);
    await expect(
      adapter.inspect({ ...mismatch.worktree, branchName: 'agentterm/task/not-current' }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'BRANCH_MISMATCH' });

    runGit(mismatch.repositoryPath, ['checkout', '--detach']);
    await expect(adapter.inspect(mismatch.worktree)).resolves.toEqual({
      kind: 'blocked',
      reason: 'DETACHED_HEAD',
    });

    const noCommits = createRepository('https://github.com/octo-org/sample.git', false);
    await expect(adapter.inspect(noCommits.worktree)).resolves.toEqual({
      kind: 'blocked',
      reason: 'NO_COMMITS_AHEAD',
    });
  }, 15_000);

  it('blocks uncommitted changes and hostile local Git command redirection', async () => {
    const dirty = createRepository('https://github.com/octo-org/sample.git', true);
    const adapter = new GitHubPullRequestAdapter('git', join(dirty.root, 'missing-gh.exe'));
    writeFileSync(join(dirty.repositoryPath, 'untracked.txt'), 'not committed\n');
    await expect(adapter.inspect(dirty.worktree)).resolves.toEqual({
      kind: 'blocked',
      reason: 'UNCOMMITTED_CHANGES',
    });

    rmSync(join(dirty.repositoryPath, 'untracked.txt'));
    runGit(dirty.repositoryPath, [
      'config',
      '--local',
      'url.file:///tmp/redirect.insteadOf',
      'https://github.com/',
    ]);
    await expect(adapter.inspect(dirty.worktree)).resolves.toEqual({
      kind: 'blocked',
      reason: 'INSPECTION_FAILED',
    });

    const customReceivePack = createRepository('https://github.com/octo-org/sample.git', true);
    runGit(customReceivePack.repositoryPath, [
      'config',
      '--local',
      'remote.origin.receivepack',
      'credential-stealing-command',
    ]);
    await expect(adapter.inspect(customReceivePack.worktree)).resolves.toEqual({
      kind: 'blocked',
      reason: 'INSPECTION_FAILED',
    });
  }, 15_000);
});

function createRepository(remoteUrl: string, withTaskCommit: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'agentterm-github-pr-'));
  temporaryDirectories.push(root);
  const repositoryPath = join(root, 'repository');
  runGit(root, ['init', '--initial-branch=main', repositoryPath]);
  runGit(repositoryPath, ['config', 'user.email', 'agentterm@example.test']);
  runGit(repositoryPath, ['config', 'user.name', 'AgentTerm Test']);
  writeFileSync(join(repositoryPath, 'tracked.txt'), 'base\n');
  runGit(repositoryPath, ['add', 'tracked.txt']);
  runGit(repositoryPath, ['commit', '-m', 'base']);
  const baseCommitId = runGit(repositoryPath, ['rev-parse', 'HEAD']);
  runGit(repositoryPath, ['remote', 'add', 'origin', remoteUrl]);
  runGit(repositoryPath, ['checkout', '-b', 'agentterm/task/pr-ready']);
  if (withTaskCommit) {
    writeFileSync(join(repositoryPath, 'tracked.txt'), 'task change\n');
    runGit(repositoryPath, ['add', 'tracked.txt']);
    runGit(repositoryPath, ['commit', '-m', 'task change']);
  }
  const headCommitId = runGit(repositoryPath, ['rev-parse', 'HEAD']);
  const worktree: TaskWorktreeRecord = Object.freeze({
    baseCommitId,
    baseRefName: 'refs/remotes/origin/main',
    branchName: 'agentterm/task/pr-ready',
    lifecycleState: 'PRESENT',
    pathIdentity: 'sha256:github-pr-test',
    repositoryRootPath: repositoryPath,
    taskId: 'task-pr',
    worktreePath: repositoryPath,
  });
  return { headCommitId, repositoryPath, root, worktree };
}

function runGit(workingDirectory: string, arguments_: readonly string[]): string {
  return execFileSync(
    'git',
    ['--no-pager', '--no-optional-locks', '-C', workingDirectory, ...arguments_],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  ).trim();
}
