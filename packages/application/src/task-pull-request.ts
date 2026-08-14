import { EntityNotFoundError, TaskPullRequestError } from './errors';
import type {
  PullRequestBranchInspection,
  PullRequestIntegration,
  PullRequestRepository,
  TaskPullRequest,
  TaskRepository,
  TaskWorktreeRecord,
  TaskWorktreeRepository,
} from './ports';
import { serializeTaskWorkflow } from './task-workflow-serialization';

export interface TaskPullRequestInput {
  readonly taskId: string;
}

export interface RefreshTaskPullRequestInput extends TaskPullRequestInput {
  readonly pullRequestNumber: number;
  readonly repositoryName: string;
  readonly repositoryOwner: string;
}

export interface TaskPullRequestDependencies {
  readonly integration: PullRequestIntegration;
  readonly pullRequests: PullRequestRepository;
  readonly tasks: TaskRepository;
  readonly worktrees: TaskWorktreeRepository;
}

export interface TaskPullRequestState {
  readonly branch: PullRequestBranchInspection;
  readonly canCreatePullRequest: boolean;
  readonly canPush: boolean;
  readonly pullRequest: TaskPullRequest | undefined;
}

export async function inspectTaskPullRequest(
  input: TaskPullRequestInput,
  dependencies: TaskPullRequestDependencies,
): Promise<TaskPullRequestState> {
  if ((await dependencies.tasks.findById(input.taskId)) === undefined) {
    throw new EntityNotFoundError('Task', input.taskId);
  }
  const [worktree, history] = await Promise.all([
    dependencies.worktrees.findByTaskId(input.taskId),
    dependencies.pullRequests.listByTaskId(input.taskId),
  ]);
  if (worktree?.lifecycleState !== 'PRESENT') {
    return createState(Object.freeze({ kind: 'blocked', reason: 'WORKTREE_NOT_READY' }), history);
  }
  const branch = await dependencies.integration.inspect(worktree);
  return createState(branch, history);
}

export async function pushTaskBranch(
  input: TaskPullRequestInput,
  dependencies: TaskPullRequestDependencies,
): Promise<TaskPullRequestState> {
  return serializeTaskWorkflow(input.taskId, async () => {
    const worktree = await requireContext(input.taskId, dependencies);
    let branch: PullRequestBranchInspection;
    try {
      branch = await dependencies.integration.push(worktree);
    } catch (error) {
      if (error instanceof TaskPullRequestError) throw error;
      throw new TaskPullRequestError('PUSH_FAILED', input.taskId, { cause: error });
    }
    const history = await dependencies.pullRequests.listByTaskId(input.taskId);
    return createState(branch, history);
  });
}

export async function createTaskPullRequest(
  input: TaskPullRequestInput,
  dependencies: TaskPullRequestDependencies,
): Promise<TaskPullRequest> {
  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await dependencies.tasks.findById(input.taskId);
    if (task === undefined) throw new EntityNotFoundError('Task', input.taskId);
    const worktree = await requirePresentWorktree(input.taskId, dependencies.worktrees);
    const branch = await dependencies.integration.inspect(worktree);
    if (branch.kind === 'blocked') {
      throw new TaskPullRequestError('BRANCH_NOT_READY', input.taskId);
    }
    if (branch.remoteHeadCommitId !== branch.headCommitId) {
      throw new TaskPullRequestError('BRANCH_NOT_PUSHED', input.taskId);
    }
    if (!branch.githubCliAvailable) {
      throw new TaskPullRequestError('GITHUB_CLI_UNAVAILABLE', input.taskId);
    }
    if (!branch.githubAuthenticationAvailable) {
      throw new TaskPullRequestError('GITHUB_AUTH_UNAVAILABLE', input.taskId);
    }
    let pullRequest: TaskPullRequest;
    try {
      pullRequest = await dependencies.integration.createOrRefresh(worktree, {
        body: createBody(task.title, task.id, branch.headBranch, branch.baseBranch),
        title: task.title,
      });
    } catch (error) {
      if (error instanceof TaskPullRequestError) throw error;
      throw new TaskPullRequestError('CREATE_FAILED', input.taskId, { cause: error });
    }
    assertMatchingMetadata(pullRequest, input.taskId, branch);
    try {
      await dependencies.pullRequests.record(pullRequest);
    } catch (error) {
      throw new TaskPullRequestError('METADATA_PERSISTENCE_FAILED', input.taskId, {
        cause: error,
      });
    }
    return pullRequest;
  });
}

export async function refreshTaskPullRequest(
  input: RefreshTaskPullRequestInput,
  dependencies: TaskPullRequestDependencies,
): Promise<TaskPullRequest> {
  return serializeTaskWorkflow(input.taskId, async () => {
    if ((await dependencies.tasks.findById(input.taskId)) === undefined) {
      throw new EntityNotFoundError('Task', input.taskId);
    }
    const persisted = (await dependencies.pullRequests.listByTaskId(input.taskId)).find(
      (pullRequest) =>
        pullRequest.number === input.pullRequestNumber &&
        pullRequest.repositoryOwner === input.repositoryOwner &&
        pullRequest.repositoryName === input.repositoryName,
    );
    if (persisted === undefined) {
      throw new TaskPullRequestError('PULL_REQUEST_NOT_FOUND', input.taskId);
    }

    let refreshed: TaskPullRequest | undefined;
    try {
      refreshed = await dependencies.integration.refresh(persisted);
    } catch (error) {
      if (error instanceof TaskPullRequestError) throw error;
      throw new TaskPullRequestError('REFRESH_FAILED', input.taskId, { cause: error });
    }
    if (refreshed === undefined) {
      throw new TaskPullRequestError('PULL_REQUEST_NOT_FOUND', input.taskId);
    }
    assertMatchingPersistedIdentity(refreshed, persisted, input.taskId);
    try {
      await dependencies.pullRequests.record(refreshed);
    } catch (error) {
      throw new TaskPullRequestError('METADATA_PERSISTENCE_FAILED', input.taskId, {
        cause: error,
      });
    }
    return refreshed;
  });
}

async function requireContext(
  taskId: string,
  dependencies: Pick<TaskPullRequestDependencies, 'tasks' | 'worktrees'>,
): Promise<TaskWorktreeRecord> {
  if ((await dependencies.tasks.findById(taskId)) === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  return requirePresentWorktree(taskId, dependencies.worktrees);
}

async function requirePresentWorktree(
  taskId: string,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeRecord> {
  const worktree = await worktrees.findByTaskId(taskId);
  if (worktree?.lifecycleState !== 'PRESENT') {
    throw new TaskPullRequestError('WORKTREE_NOT_READY', taskId);
  }
  return worktree;
}

function createState(
  branch: PullRequestBranchInspection,
  history: readonly TaskPullRequest[],
): TaskPullRequestState {
  const repositoryHistory =
    branch.kind === 'ready'
      ? history
          .slice()
          .reverse()
          .filter(
            (pullRequest) =>
              pullRequest.provider === branch.provider &&
              pullRequest.repositoryOwner === branch.repositoryOwner &&
              pullRequest.repositoryName === branch.repositoryName,
          )
      : [];
  const persisted =
    branch.kind === 'ready'
      ? (repositoryHistory.find((pullRequest) => pullRequest.headBranch === branch.headBranch) ??
        repositoryHistory[0])
      : history.at(-1);
  const pullRequest = branch.kind === 'ready' ? (branch.pullRequest ?? persisted) : persisted;
  return Object.freeze({
    branch,
    canCreatePullRequest:
      branch.kind === 'ready' &&
      branch.githubCliAvailable &&
      branch.githubAuthenticationAvailable &&
      branch.remoteHeadCommitId === branch.headCommitId &&
      pullRequest === undefined,
    canPush: branch.kind === 'ready' && branch.remoteHeadCommitId !== branch.headCommitId,
    pullRequest,
  });
}

function createBody(title: string, taskId: string, headBranch: string, baseBranch: string): string {
  return (
    '## AgentTerm Task\n\n' +
    `- Task: ${title} (\`${taskId}\`)\n` +
    `- Head: \`${headBranch}\`\n` +
    `- Base: \`${baseBranch}\`\n\n` +
    'Created explicitly by the user from AgentTerm.'
  );
}

function assertMatchingMetadata(
  pullRequest: TaskPullRequest,
  taskId: string,
  branch: Extract<PullRequestBranchInspection, { readonly kind: 'ready' }>,
): void {
  if (
    pullRequest.taskId !== taskId ||
    pullRequest.provider !== branch.provider ||
    pullRequest.repositoryOwner !== branch.repositoryOwner ||
    pullRequest.repositoryName !== branch.repositoryName ||
    pullRequest.baseBranch !== branch.baseBranch ||
    pullRequest.headBranch !== branch.headBranch ||
    pullRequest.headCommitId !== branch.headCommitId
  ) {
    throw new TaskPullRequestError('METADATA_MISMATCH', taskId);
  }
}

function assertMatchingPersistedIdentity(
  pullRequest: TaskPullRequest,
  persisted: TaskPullRequest,
  taskId: string,
): void {
  if (
    pullRequest.taskId !== taskId ||
    pullRequest.provider !== persisted.provider ||
    pullRequest.repositoryOwner !== persisted.repositoryOwner ||
    pullRequest.repositoryName !== persisted.repositoryName ||
    pullRequest.number !== persisted.number ||
    pullRequest.url !== persisted.url
  ) {
    throw new TaskPullRequestError('METADATA_MISMATCH', taskId);
  }
}
