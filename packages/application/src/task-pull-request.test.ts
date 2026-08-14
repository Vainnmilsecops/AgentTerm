import { describe, expect, it, vi } from 'vitest';

import { TaskPhase, createTask, transitionTask, type Task } from '@agentterm/domain';

import {
  createTaskPullRequest,
  inspectTaskPullRequest,
  pushTaskBranch,
  refreshTaskPullRequest,
  type PullRequestBranchInspection,
  type PullRequestIntegration,
  type PullRequestRepository,
  type TaskPullRequest,
  type TaskPullRequestDependencies,
  type TaskRepository,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from './index';

const task = transitionTask(
  transitionTask(
    createTask({ id: 'task-pr', projectId: 'project-1', title: 'Add explicit PR flow' }),
    TaskPhase.PLANNING,
  ),
  TaskPhase.RUNNING,
);

const worktree: TaskWorktreeRecord = Object.freeze({
  baseCommitId: 'a'.repeat(40),
  baseRefName: 'refs/remotes/origin/main',
  branchName: 'agentterm/task/pr-flow',
  lifecycleState: 'PRESENT',
  pathIdentity: 'sha256:task-pr',
  repositoryRootPath: 'D:\\Repositories\\AgentTerm',
  taskId: task.id,
  worktreePath: 'D:\\Worktrees\\task-pr',
});

const readyBranch: Extract<PullRequestBranchInspection, { readonly kind: 'ready' }> = Object.freeze(
  {
    baseBranch: 'main',
    githubAuthenticationAvailable: true,
    githubCliAvailable: true,
    headBranch: worktree.branchName,
    headCommitId: 'b'.repeat(40),
    kind: 'ready' as const,
    provider: 'github' as const,
    pullRequest: undefined,
    remoteHeadCommitId: undefined,
    remoteName: 'origin',
    repositoryName: 'AgentTerm',
    repositoryOwner: 'agentterm',
  },
);

const pullRequest: TaskPullRequest = Object.freeze({
  baseBranch: 'main',
  checks: Object.freeze({
    failureCount: 0,
    pendingCount: 0,
    state: 'UNKNOWN',
    successCount: 0,
    totalCount: 0,
  }),
  createdAt: 1_800_000_000_000,
  draft: false,
  headBranch: worktree.branchName,
  headCommitId: readyBranch.headCommitId,
  lastSyncedAt: 1_800_000_000_200,
  number: 42,
  provider: 'github',
  repositoryName: 'AgentTerm',
  repositoryOwner: 'agentterm',
  reviewState: 'UNKNOWN',
  status: 'OPEN',
  taskId: task.id,
  title: task.title,
  updatedAt: 1_800_000_000_100,
  url: 'https://github.com/agentterm/AgentTerm/pull/42',
});

describe('Task Pull Request use cases', () => {
  it('combines exact Worktree readiness with persisted PR metadata without changing Task state', async () => {
    const fixture = createFixture({ persisted: [pullRequest] });

    await expect(
      inspectTaskPullRequest({ taskId: task.id }, fixture.dependencies),
    ).resolves.toEqual({
      branch: readyBranch,
      canCreatePullRequest: false,
      canPush: true,
      pullRequest,
    });

    expect(fixture.integration.inspect).toHaveBeenCalledWith(worktree);
    expect(await fixture.tasks.findById(task.id)).toEqual(task);
  });

  it('pushes only through an explicit command and does not persist fake PR metadata', async () => {
    const pushed = Object.freeze({
      ...readyBranch,
      remoteHeadCommitId: readyBranch.headCommitId,
    });
    const fixture = createFixture({ pushResult: pushed });

    await expect(pushTaskBranch({ taskId: task.id }, fixture.dependencies)).resolves.toEqual({
      branch: pushed,
      canCreatePullRequest: true,
      canPush: false,
      pullRequest: undefined,
    });

    expect(fixture.integration.push).toHaveBeenCalledWith(worktree);
    expect(fixture.pullRequests.values).toEqual([]);
    expect(await fixture.tasks.findById(task.id)).toEqual(task);
  });

  it('creates or refreshes the exact PR and records only returned metadata', async () => {
    const pushed = Object.freeze({
      ...readyBranch,
      remoteHeadCommitId: readyBranch.headCommitId,
    });
    const fixture = createFixture({ createResult: pullRequest, inspectResult: pushed });

    await expect(createTaskPullRequest({ taskId: task.id }, fixture.dependencies)).resolves.toEqual(
      pullRequest,
    );

    expect(fixture.integration.createOrRefresh).toHaveBeenCalledWith(worktree, {
      body:
        '## AgentTerm Task\n\n' +
        '- Task: Add explicit PR flow (`task-pr`)\n' +
        '- Head: `agentterm/task/pr-flow`\n' +
        '- Base: `main`\n\n' +
        'Created explicitly by the user from AgentTerm.',
      title: 'Add explicit PR flow',
    });
    expect(fixture.pullRequests.values).toEqual([pullRequest]);
    expect(await fixture.tasks.findById(task.id)).toEqual(task);
  });

  it.each(['OPEN', 'CLOSED', 'MERGED'] as const)(
    'refreshes a persisted Pull Request to remote %s without changing Task state',
    async (status) => {
      const refreshed = Object.freeze({
        ...pullRequest,
        checks: Object.freeze({
          failureCount: status === 'OPEN' ? 0 : 1,
          pendingCount: 0,
          state: status === 'OPEN' ? ('SUCCESS' as const) : ('FAILURE' as const),
          successCount: status === 'OPEN' ? 2 : 1,
          totalCount: 2,
        }),
        lastSyncedAt: (pullRequest.lastSyncedAt ?? 0) + 100,
        reviewState: status === 'OPEN' ? ('APPROVED' as const) : ('CHANGES_REQUESTED' as const),
        status,
        updatedAt: pullRequest.updatedAt + 50,
      });
      const fixture = createFixture({ persisted: [pullRequest], refreshResult: refreshed });

      await expect(
        refreshTaskPullRequest(
          {
            pullRequestNumber: pullRequest.number,
            repositoryName: pullRequest.repositoryName,
            repositoryOwner: pullRequest.repositoryOwner,
            taskId: task.id,
          },
          fixture.dependencies,
        ),
      ).resolves.toEqual(refreshed);

      expect(fixture.integration.refresh).toHaveBeenCalledWith(pullRequest);
      expect(fixture.pullRequests.values).toEqual([refreshed]);
      expect(await fixture.tasks.findById(task.id)).toEqual(task);
    },
  );

  it('accepts GitHub-owned base/head metadata changes for the same persisted PR identity', async () => {
    const refreshed = Object.freeze({
      ...pullRequest,
      baseBranch: 'release',
      headCommitId: 'c'.repeat(40),
      lastSyncedAt: (pullRequest.lastSyncedAt ?? 0) + 1,
    });
    const fixture = createFixture({ persisted: [pullRequest], refreshResult: refreshed });

    await expect(
      refreshTaskPullRequest(
        {
          pullRequestNumber: pullRequest.number,
          repositoryName: pullRequest.repositoryName,
          repositoryOwner: pullRequest.repositoryOwner,
          taskId: task.id,
        },
        fixture.dependencies,
      ),
    ).resolves.toEqual(refreshed);
  });

  it('preserves last-known-good metadata when remote refresh fails or the PR is missing', async () => {
    const failed = createFixture({
      persisted: [pullRequest],
      refreshError: new Error('network failed GH_TOKEN=secret'),
    });
    await expect(
      refreshTaskPullRequest(
        {
          pullRequestNumber: pullRequest.number,
          repositoryName: pullRequest.repositoryName,
          repositoryOwner: pullRequest.repositoryOwner,
          taskId: task.id,
        },
        failed.dependencies,
      ),
    ).rejects.toMatchObject({
      message: 'The Pull Request status could not be refreshed from GitHub.',
      reason: 'REFRESH_FAILED',
    });
    expect(failed.pullRequests.values).toEqual([pullRequest]);

    const missing = createFixture({ persisted: [pullRequest], refreshResult: undefined });
    await expect(
      refreshTaskPullRequest(
        {
          pullRequestNumber: pullRequest.number,
          repositoryName: pullRequest.repositoryName,
          repositoryOwner: pullRequest.repositoryOwner,
          taskId: task.id,
        },
        missing.dependencies,
      ),
    ).rejects.toMatchObject({ reason: 'PULL_REQUEST_NOT_FOUND' });
    expect(missing.pullRequests.values).toEqual([pullRequest]);
  });

  it('rejects refresh when no persisted Pull Request exists before calling GitHub', async () => {
    const fixture = createFixture();

    await expect(
      refreshTaskPullRequest(
        {
          pullRequestNumber: pullRequest.number,
          repositoryName: pullRequest.repositoryName,
          repositoryOwner: pullRequest.repositoryOwner,
          taskId: task.id,
        },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ reason: 'PULL_REQUEST_NOT_FOUND' });

    expect(fixture.integration.refresh).not.toHaveBeenCalled();
  });

  it('preserves persistence when push or create fails', async () => {
    const pushFailure = createFixture({ pushError: new Error('credential TOKEN=secret') });
    await expect(
      pushTaskBranch({ taskId: task.id }, pushFailure.dependencies),
    ).rejects.toMatchObject({
      message: 'The Task branch could not be pushed.',
      reason: 'PUSH_FAILED',
    });
    expect(pushFailure.pullRequests.values).toEqual([]);

    const createFailure = createFixture({ createError: new Error('gh failed with token') });
    await expect(
      createTaskPullRequest({ taskId: task.id }, createFailure.dependencies),
    ).rejects.toThrow();
    expect(createFailure.pullRequests.values).toEqual([]);
  });

  it('keeps branch-associated stale metadata visible for explicit remote refresh', async () => {
    const fixture = createFixture({
      persisted: [Object.freeze({ ...pullRequest, headCommitId: 'c'.repeat(40) })],
    });

    await expect(
      inspectTaskPullRequest({ taskId: task.id }, fixture.dependencies),
    ).resolves.toMatchObject({ pullRequest: { number: pullRequest.number } });
  });

  it('does not advertise create when gh authentication is unavailable', async () => {
    const fixture = createFixture({
      inspectResult: Object.freeze({
        ...readyBranch,
        githubAuthenticationAvailable: false,
        remoteHeadCommitId: readyBranch.headCommitId,
      }),
    });

    await expect(
      inspectTaskPullRequest({ taskId: task.id }, fixture.dependencies),
    ).resolves.toMatchObject({ canCreatePullRequest: false });
    await expect(
      createTaskPullRequest({ taskId: task.id }, fixture.dependencies),
    ).rejects.toMatchObject({ reason: 'GITHUB_AUTH_UNAVAILABLE' });
  });

  it('reports a missing or non-PRESENT Worktree as blocked before invoking GitHub integration', async () => {
    for (const record of [undefined, { ...worktree, lifecycleState: 'REMOVED' as const }]) {
      const fixture = createFixture({ worktree: record });

      await expect(
        inspectTaskPullRequest({ taskId: task.id }, fixture.dependencies),
      ).resolves.toEqual({
        branch: { kind: 'blocked', reason: 'WORKTREE_NOT_READY' },
        canCreatePullRequest: false,
        canPush: false,
        pullRequest: undefined,
      });
      expect(fixture.integration.inspect).not.toHaveBeenCalled();
    }
  });
});

function createFixture(
  options: {
    readonly createError?: Error;
    readonly createResult?: TaskPullRequest;
    readonly inspectResult?: PullRequestBranchInspection;
    readonly persisted?: readonly TaskPullRequest[];
    readonly pushError?: Error;
    readonly pushResult?: PullRequestBranchInspection;
    readonly refreshError?: Error;
    readonly refreshResult?: TaskPullRequest | undefined;
    readonly worktree?: TaskWorktreeRecord | undefined;
  } = {},
) {
  const tasks = taskRepository(task);
  const pullRequests = new MemoryPullRequests(options.persisted ?? []);
  const inspectResult = options.inspectResult ?? readyBranch;
  const integration = {
    createOrRefresh: vi.fn(async () => {
      if (options.createError !== undefined) throw options.createError;
      return options.createResult ?? pullRequest;
    }),
    inspect: vi.fn(async () => inspectResult),
    push: vi.fn(async () => {
      if (options.pushError !== undefined) throw options.pushError;
      return options.pushResult ?? inspectResult;
    }),
    refresh: vi.fn(async () => {
      if (options.refreshError !== undefined) throw options.refreshError;
      return 'refreshResult' in options ? options.refreshResult : pullRequest;
    }),
  } satisfies PullRequestIntegration;
  const dependencies: TaskPullRequestDependencies = {
    integration,
    pullRequests,
    tasks,
    worktrees: worktreeRepository('worktree' in options ? options.worktree : worktree),
  };
  return { dependencies, integration, pullRequests, tasks };
}

class MemoryPullRequests implements PullRequestRepository {
  public readonly values: TaskPullRequest[];

  public constructor(values: readonly TaskPullRequest[]) {
    this.values = [...values];
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskPullRequest[]> {
    return this.values.filter((pullRequest) => pullRequest.taskId === taskId);
  }

  public async record(pullRequest: TaskPullRequest): Promise<void> {
    const index = this.values.findIndex(
      (candidate) =>
        candidate.taskId === pullRequest.taskId &&
        candidate.repositoryOwner === pullRequest.repositoryOwner &&
        candidate.repositoryName === pullRequest.repositoryName &&
        candidate.baseBranch === pullRequest.baseBranch &&
        candidate.headBranch === pullRequest.headBranch,
    );
    if (index < 0) this.values.push(pullRequest);
    else this.values[index] = pullRequest;
  }
}

function taskRepository(value: Task): TaskRepository {
  return {
    findById: async (id) => (id === value.id ? value : undefined),
    insert: async () => undefined,
    update: async () => undefined,
  };
}

function worktreeRepository(value: TaskWorktreeRecord | undefined): TaskWorktreeRepository {
  return {
    findByTaskId: async (taskId) => (value?.taskId === taskId ? value : undefined),
    insertReservation: async () => {
      throw new Error('PR workflow must not reserve a Worktree.');
    },
    transitionState: async () => {
      throw new Error('PR workflow must not mutate Worktree metadata.');
    },
  };
}
