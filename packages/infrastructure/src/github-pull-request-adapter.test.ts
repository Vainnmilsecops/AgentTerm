import { describe, expect, it, vi } from 'vitest';

import {
  TaskPullRequestError,
  type PullRequestBranchInspection,
  type TaskPullRequest,
  type TaskWorktreeRecord,
} from '@agentterm/application';

import { GitHubPullRequestAdapter } from './index';

type GitHubRequestJson = (
  method: 'GET' | 'POST',
  path: string,
  input?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

const worktree: TaskWorktreeRecord = Object.freeze({
  baseCommitId: 'a'.repeat(40),
  baseRefName: 'refs/remotes/origin/main',
  branchName: 'agentterm/task/github-pr',
  lifecycleState: 'PRESENT',
  pathIdentity: 'sha256:github-pr-unit',
  repositoryRootPath: 'D:\\Repositories\\AgentTerm',
  taskId: 'task-github-pr',
  worktreePath: 'D:\\Worktrees\\task-github-pr',
});

const ready: Extract<PullRequestBranchInspection, { readonly kind: 'ready' }> = Object.freeze({
  baseBranch: 'main',
  githubAuthenticationAvailable: true,
  githubCliAvailable: true,
  headBranch: worktree.branchName,
  headCommitId: 'b'.repeat(40),
  kind: 'ready',
  provider: 'github',
  pullRequest: undefined,
  remoteHeadCommitId: undefined,
  remoteName: 'origin',
  repositoryName: 'AgentTerm',
  repositoryOwner: 'agentterm',
});

describe('GitHub Pull Request command boundary', () => {
  it('pushes the inspected commit to the exact branch without force', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '' }));
    const adapter = createAdapter({ git: { run }, inspections: [ready, pushedReady()] });

    await expect(adapter.push(worktree)).resolves.toEqual(pushedReady());

    expect(run).toHaveBeenCalledWith(
      worktree.worktreePath,
      [
        'push',
        '--porcelain',
        '--no-verify',
        '--no-follow-tags',
        '--signed=false',
        '--recurse-submodules=no',
        '--',
        'origin',
        `${ready.headCommitId}:refs/heads/${ready.headBranch}`,
      ],
      { maxBuffer: 1024 * 1024, timeout: 120_000 },
    );
    expect(run.mock.calls.flat(2)).not.toContain('--force');
  });

  it('maps push failures to a sanitized failure without retrying with force', async () => {
    const run = vi.fn(async () => ({ exitCode: 1, stdout: 'TOKEN=secret' }));
    const adapter = createAdapter({ git: { run }, inspections: [ready] });

    await expect(adapter.push(worktree)).rejects.toMatchObject({
      name: 'TaskPullRequestError',
      reason: 'PUSH_FAILED',
      taskId: worktree.taskId,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['OPEN', 'open', undefined],
    ['MERGED', 'closed', '2026-08-14T12:00:00Z'],
  ] as const)(
    'reuses a matching %s Pull Request without creating a duplicate',
    async (expectedStatus, state, mergedAt) => {
      const requestJson = vi.fn<GitHubRequestJson>(async () => [
        githubPullRequest({ ...(mergedAt === undefined ? {} : { mergedAt }), state }),
      ]);
      const adapter = createAdapter({ github: githubClient(requestJson) });

      await expect(
        adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' }),
      ).resolves.toMatchObject({ number: 42, status: expectedStatus });

      expect(requestJson).toHaveBeenCalledTimes(1);
      expect(requestJson.mock.calls[0]?.[0]).toBe('GET');
    },
  );

  it('returns a matching closed Pull Request without reopening or duplicating it', async () => {
    const requestJson = vi.fn<GitHubRequestJson>(async () => [
      githubPullRequest({ state: 'closed' }),
    ]);
    const adapter = createAdapter({ github: githubClient(requestJson) });

    await expect(
      adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' }),
    ).resolves.toMatchObject({ number: 42, status: 'CLOSED' });

    expect(requestJson.mock.calls.some((call) => call[0] === 'POST')).toBe(false);
  });

  it('refreshes the exact PR number when GitHub changed its base branch', async () => {
    const requestJson = vi.fn<GitHubRequestJson>(async (_method, path) => {
      if (path === '/repos/agentterm/AgentTerm/pulls/42') {
        return { ...githubPullRequest({ state: 'open' }), base: { ref: 'release' } };
      }
      if (path.includes('/reviews?')) return [];
      if (path.includes('/check-runs?')) return { check_runs: [], total_count: 0 };
      if (path.includes('/status?')) return { state: 'pending', statuses: [], total_count: 0 };
      throw new Error('Unexpected GitHub path.');
    });

    await expect(
      createAdapter({ github: githubClient(requestJson) }).refresh(persistedPullRequest()),
    ).resolves.toMatchObject({ baseBranch: 'release', number: 42 });
  });

  it.each([
    ['OPEN', 'open', undefined],
    ['CLOSED', 'closed', undefined],
    ['MERGED', 'closed', '2026-08-14T12:00:00Z'],
  ] as const)('refreshes remote Pull Request state as %s', async (status, state, mergedAt) => {
    const requestJson = vi.fn<GitHubRequestJson>(async (_method, path) => {
      if (path.endsWith('/pulls/42')) {
        return githubPullRequest({ ...(mergedAt === undefined ? {} : { mergedAt }), state });
      }
      if (path.includes('/reviews?')) return [];
      if (path.includes('/check-runs?')) return { check_runs: [], total_count: 0 };
      if (path.includes('/status?')) return { state: 'pending', statuses: [], total_count: 0 };
      throw new Error('Unexpected GitHub path.');
    });
    const adapter = createAdapter({
      clock: () => 1_800_000_000_500,
      github: githubClient(requestJson),
    });

    await expect(adapter.refresh(persistedPullRequest())).resolves.toMatchObject({
      checks: { state: 'NONE', totalCount: 0 },
      lastSyncedAt: 1_800_000_000_500,
      reviewState: 'NONE',
      status,
    });
  });

  it('maps latest reviewer decisions and GitHub checks/statuses into a bounded summary', async () => {
    const requestJson = vi.fn<GitHubRequestJson>(async (_method, path) => {
      if (path.endsWith('/pulls/42')) return githubPullRequest({ state: 'open' });
      if (path.includes('/reviews?')) {
        return [
          githubReview('alice', 'APPROVED', '2026-08-14T10:00:00Z'),
          githubReview('bob', 'COMMENTED', '2026-08-14T10:01:00Z'),
          githubReview('alice', 'CHANGES_REQUESTED', '2026-08-14T10:02:00Z'),
        ];
      }
      if (path.includes('/check-runs?')) {
        return {
          check_runs: [
            { conclusion: 'success', id: 1, status: 'completed' },
            { conclusion: null, id: 2, status: 'in_progress' },
          ],
          total_count: 2,
        };
      }
      if (path.includes('/status?')) {
        return {
          state: 'failure',
          statuses: [{ context: 'legacy/ci', id: 3, state: 'failure' }],
          total_count: 1,
        };
      }
      throw new Error('Unexpected GitHub path.');
    });
    const adapter = createAdapter({ github: githubClient(requestJson) });

    await expect(adapter.refresh(persistedPullRequest())).resolves.toMatchObject({
      checks: {
        failureCount: 1,
        pendingCount: 1,
        state: 'FAILURE',
        successCount: 1,
        totalCount: 3,
      },
      reviewState: 'CHANGES_REQUESTED',
    });
  });

  it('keeps an approval when the same reviewer later leaves a non-decisive comment', async () => {
    const requestJson = vi.fn<GitHubRequestJson>(async (_method, path) => {
      if (path.endsWith('/pulls/42')) return githubPullRequest({ state: 'open' });
      if (path.includes('/reviews?')) {
        return [
          githubReview('alice', 'APPROVED', '2026-08-14T10:00:00Z'),
          githubReview('alice', 'COMMENTED', '2026-08-14T10:01:00Z'),
        ];
      }
      if (path.includes('/check-runs?')) return { check_runs: [], total_count: 0 };
      if (path.includes('/status?')) return { state: 'pending', statuses: [], total_count: 0 };
      throw new Error('Unexpected GitHub path.');
    });

    await expect(
      createAdapter({ github: githubClient(requestJson) }).refresh(persistedPullRequest()),
    ).resolves.toMatchObject({ reviewState: 'APPROVED' });
  });

  it('returns missing without mutation and sanitizes remote refresh failures', async () => {
    const missingRequest = vi.fn<GitHubRequestJson>(async (_method, path) => {
      if (path.endsWith('/pulls/42')) return undefined;
      throw new Error('Unexpected GitHub path.');
    });
    const missing = createAdapter({ github: githubClient(missingRequest) });
    await expect(missing.refresh(persistedPullRequest())).resolves.toBeUndefined();
    expect(missingRequest.mock.calls.every((call) => call[0] === 'GET')).toBe(true);

    const failed = createAdapter({
      github: githubClient(
        vi.fn<GitHubRequestJson>(async () => {
          throw new Error('network failed GH_TOKEN=secret');
        }),
      ),
    });
    await expect(failed.refresh(persistedPullRequest())).rejects.toEqual(
      new TaskPullRequestError('REFRESH_FAILED', worktree.taskId),
    );
  });

  it('creates through JSON stdin only when no matching head/base Pull Request exists', async () => {
    const requestJson = vi
      .fn<GitHubRequestJson>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(githubPullRequest({ state: 'open' }));
    const adapter = createAdapter({ github: githubClient(requestJson) });

    await expect(
      adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' }),
    ).resolves.toMatchObject({ number: 42, status: 'OPEN' });

    expect(requestJson).toHaveBeenNthCalledWith(2, 'POST', '/repos/agentterm/AgentTerm/pulls', {
      base: 'main',
      body: 'Safe body',
      head: 'agentterm/task/github-pr',
      title: 'Explicit PR',
    });
  });

  it('ignores unrelated API results before duplicate prevention', async () => {
    const requestJson = vi
      .fn<GitHubRequestJson>()
      .mockResolvedValueOnce([
        {
          ...githubPullRequest({ state: 'open' }),
          head: { ref: 'agentterm/task/another', sha: 'c'.repeat(40) },
        },
      ])
      .mockResolvedValueOnce(githubPullRequest({ state: 'open' }));
    const adapter = createAdapter({ github: githubClient(requestJson) });

    await adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' });

    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/repos/agentterm/AgentTerm/pulls',
      expect.objectContaining({ head: ready.headBranch }),
    );
  });

  it('checks another bounded page before creating when a full page has no exact match', async () => {
    const unrelated = {
      ...githubPullRequest({ state: 'closed' }),
      head: { ref: 'agentterm/task/old', sha: 'c'.repeat(40) },
    };
    const requestJson = vi
      .fn<GitHubRequestJson>()
      .mockResolvedValueOnce(Array.from({ length: 100 }, () => unrelated))
      .mockResolvedValueOnce([githubPullRequest({ state: 'open' })]);
    const adapter = createAdapter({ github: githubClient(requestJson) });

    await expect(
      adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' }),
    ).resolves.toMatchObject({ number: 42, status: 'OPEN' });

    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      'GET',
      expect.stringContaining('page=2'),
      undefined,
    );
    expect(requestJson.mock.calls.some((call) => call[0] === 'POST')).toBe(false);
  });

  it('maps GitHub CLI/API failures without exposing provider output', async () => {
    const requestJson = vi.fn<GitHubRequestJson>(async () => {
      throw new Error('gh stderr TOKEN=secret');
    });
    const adapter = createAdapter({ github: githubClient(requestJson) });

    await expect(
      adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' }),
    ).rejects.toEqual(new TaskPullRequestError('CREATE_FAILED', worktree.taskId));
  });

  it('blocks creation before listing or mutation when the actual GitHub head ref is stale', async () => {
    const requestJson = vi.fn<GitHubRequestJson>();
    const adapter = createAdapter({
      github: githubClient(requestJson, 'c'.repeat(40)),
    });

    await expect(
      adapter.createOrRefresh(worktree, { body: 'Safe body', title: 'Explicit PR' }),
    ).rejects.toMatchObject({ reason: 'BRANCH_NOT_READY' });
    expect(requestJson).not.toHaveBeenCalled();
  });
});

function createAdapter(options: {
  readonly clock?: () => number;
  readonly git?: { readonly run: ReturnType<typeof vi.fn> };
  readonly github?: {
    readonly isAvailable: () => Promise<boolean>;
    readonly isAuthenticated: () => Promise<boolean>;
    readonly requestJson: GitHubRequestJson;
  };
  readonly inspections?: readonly PullRequestBranchInspection[];
}): GitHubPullRequestAdapter {
  const adapter = new GitHubPullRequestAdapter('git', 'gh', {
    clock: options.clock,
    git: options.git,
    github: options.github,
  } as never);
  const inspections = [...(options.inspections ?? [pushedReady()])];
  vi.spyOn(adapter, 'inspect').mockImplementation(async () => inspections.shift() ?? pushedReady());
  return adapter;
}

function persistedPullRequest(): TaskPullRequest {
  return Object.freeze({
    baseBranch: ready.baseBranch,
    checks: Object.freeze({
      failureCount: 0,
      pendingCount: 0,
      state: 'UNKNOWN',
      successCount: 0,
      totalCount: 0,
    }),
    createdAt: 1_800_000_000_000,
    draft: false,
    headBranch: ready.headBranch,
    headCommitId: ready.headCommitId,
    lastSyncedAt: 1_800_000_000_100,
    number: 42,
    provider: 'github',
    repositoryName: ready.repositoryName,
    repositoryOwner: ready.repositoryOwner,
    reviewState: 'UNKNOWN',
    status: 'OPEN',
    taskId: worktree.taskId,
    title: 'Explicit PR',
    updatedAt: 1_800_000_000_100,
    url: 'https://github.com/agentterm/AgentTerm/pull/42',
  });
}

function githubReview(login: string, state: string, submittedAt: string) {
  return {
    id: Math.abs(login.length * submittedAt.length),
    state,
    submitted_at: submittedAt,
    user: { login },
  };
}

function githubClient(requestJson: GitHubRequestJson, remoteHeadCommitId = ready.headCommitId) {
  return {
    isAuthenticated: async () => true,
    isAvailable: async () => true,
    requestJson: async (
      method: 'GET' | 'POST',
      path: string,
      input?: Readonly<Record<string, unknown>>,
    ) =>
      path.includes('/git/ref/heads/')
        ? { object: { sha: remoteHeadCommitId } }
        : requestJson(method, path, input),
    requestOptionalJson: async (path: string) => requestJson('GET', path),
  };
}

function pushedReady(): Extract<PullRequestBranchInspection, { readonly kind: 'ready' }> {
  return Object.freeze({ ...ready, remoteHeadCommitId: ready.headCommitId });
}

function githubPullRequest(options: {
  readonly mergedAt?: string;
  readonly state: 'closed' | 'open';
}) {
  return {
    base: { ref: 'main' },
    created_at: '2026-08-14T10:00:00Z',
    draft: false,
    head: { ref: 'agentterm/task/github-pr', sha: ready.headCommitId },
    html_url: 'https://github.com/agentterm/AgentTerm/pull/42',
    merged_at: options.mergedAt ?? null,
    number: 42,
    state: options.state,
    title: 'Explicit PR',
    updated_at: '2026-08-14T12:00:00Z',
  };
}
