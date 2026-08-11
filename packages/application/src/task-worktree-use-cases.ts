import {
  EntityNotFoundError,
  TaskWorktreeLifecycleError,
  TaskWorktreeMetadataConflictError,
  TaskWorktreePersistenceError,
} from './errors';
import type {
  GitTaskWorktreeLifecycle,
  LocalProject,
  LocalProjectLocator,
  TaskRepository,
  TaskWorktree,
  TaskWorktreeCleanupResult,
  TaskWorktreeEnsureResult,
  TaskWorktreeInspection,
  TaskWorktreeLifecycleState,
  TaskWorktreeRecord,
  TaskWorktreeRepository,
} from './ports';

export interface TaskWorktreeInput {
  readonly taskId: string;
}

export interface InspectTaskWorktreeResult {
  readonly actual: TaskWorktreeInspection;
  readonly persistedState: TaskWorktreeLifecycleState | undefined;
}

interface TaskWorktreeContext {
  readonly localProject: LocalProject;
  readonly record: TaskWorktreeRecord | undefined;
}

const taskWorktreeOperationTails = new Map<string, Promise<void>>();

export async function ensureTaskWorktree(
  input: TaskWorktreeInput,
  tasks: TaskRepository,
  localProjects: LocalProjectLocator,
  worktrees: TaskWorktreeRepository,
  git: GitTaskWorktreeLifecycle,
): Promise<TaskWorktreeEnsureResult> {
  return serializeTaskWorktreeOperation(input.taskId, () =>
    ensureTaskWorktreeExclusive(input, tasks, localProjects, worktrees, git),
  );
}

async function ensureTaskWorktreeExclusive(
  input: TaskWorktreeInput,
  tasks: TaskRepository,
  localProjects: LocalProjectLocator,
  worktrees: TaskWorktreeRepository,
  git: GitTaskWorktreeLifecycle,
): Promise<TaskWorktreeEnsureResult> {
  const context = await loadContext(input.taskId, tasks, localProjects, worktrees);

  if (context.record?.lifecycleState === 'REMOVING') {
    throw new TaskWorktreeLifecycleError('OPERATION_IN_PROGRESS', input.taskId);
  }

  const actual = await git.inspect({
    ...(context.record === undefined ? {} : { recordedWorktree: context.record }),
    repositoryRootPath: context.localProject.rootPath,
    taskId: input.taskId,
  });

  if (actual.kind === 'stale-registration' && actual.status.isDirty) {
    throw new TaskWorktreeLifecycleError('DIRTY_WORKTREE', input.taskId, {
      recoveryPath: actual.recoveryPath,
      status: actual.status,
    });
  }

  if (actual.kind === 'present') {
    try {
      await persistPresent(actual.worktree, context.record, worktrees);
    } catch (error) {
      if (error instanceof TaskWorktreeLifecycleError) {
        throw error;
      }

      throw new TaskWorktreePersistenceError('ensure', 'PRESENT', actual.worktree, {
        cause: error,
      });
    }

    return Object.freeze({ kind: 'reused', status: actual.status, worktree: actual.worktree });
  }

  const provisioning = await persistProvisioning(actual.worktree, context.record, worktrees);
  const ensured = await git.ensure(actual.worktree);

  try {
    await transitionToPresent(provisioning, worktrees);
  } catch (error) {
    throw new TaskWorktreePersistenceError('ensure', 'PRESENT', actual.worktree, {
      cause: error,
    });
  }

  return ensured;
}

export async function inspectTaskWorktree(
  input: TaskWorktreeInput,
  tasks: TaskRepository,
  localProjects: LocalProjectLocator,
  worktrees: TaskWorktreeRepository,
  git: GitTaskWorktreeLifecycle,
): Promise<InspectTaskWorktreeResult> {
  const context = await loadContext(input.taskId, tasks, localProjects, worktrees);
  const actual = await git.inspect({
    ...(context.record === undefined ? {} : { recordedWorktree: context.record }),
    repositoryRootPath: context.localProject.rootPath,
    taskId: input.taskId,
  });

  return Object.freeze({ actual, persistedState: context.record?.lifecycleState });
}

/** Requires exclusive ownership so no process or session can write during cleanup. */
export async function cleanupTaskWorktree(
  input: TaskWorktreeInput,
  tasks: TaskRepository,
  localProjects: LocalProjectLocator,
  worktrees: TaskWorktreeRepository,
  git: GitTaskWorktreeLifecycle,
): Promise<TaskWorktreeCleanupResult> {
  return serializeTaskWorktreeOperation(input.taskId, () =>
    cleanupTaskWorktreeExclusive(input, tasks, localProjects, worktrees, git),
  );
}

async function cleanupTaskWorktreeExclusive(
  input: TaskWorktreeInput,
  tasks: TaskRepository,
  localProjects: LocalProjectLocator,
  worktrees: TaskWorktreeRepository,
  git: GitTaskWorktreeLifecycle,
): Promise<TaskWorktreeCleanupResult> {
  const context = await loadContext(input.taskId, tasks, localProjects, worktrees);

  if (context.record?.lifecycleState === 'PROVISIONING') {
    throw new TaskWorktreeLifecycleError('OPERATION_IN_PROGRESS', input.taskId);
  }

  const actual = await git.inspect({
    ...(context.record === undefined ? {} : { recordedWorktree: context.record }),
    repositoryRootPath: context.localProject.rootPath,
    taskId: input.taskId,
  });

  if (
    (actual.kind === 'present' || actual.kind === 'stale-registration') &&
    (actual.status.isDirty || actual.status.ignoredPaths.length > 0)
  ) {
    throw new TaskWorktreeLifecycleError('DIRTY_WORKTREE', input.taskId, {
      ...(actual.kind === 'stale-registration' ? { recoveryPath: actual.recoveryPath } : {}),
      status: actual.status,
    });
  }

  if (context.record === undefined && actual.kind === 'missing') {
    return Object.freeze({ kind: 'already-missing', worktree: actual.worktree });
  }

  let record = context.record ?? (await persistPresent(actual.worktree, undefined, worktrees));

  if (actual.kind === 'missing') {
    if (record.lifecycleState === 'REMOVED') {
      return Object.freeze({ kind: 'already-missing', worktree: actual.worktree });
    }

    try {
      record = await transitionToRemoving(record, worktrees);
      await worktrees.transitionState(record.taskId, 'REMOVING', 'REMOVED');
    } catch (error) {
      throw new TaskWorktreePersistenceError('cleanup', 'REMOVED', actual.worktree, {
        cause: error,
      });
    }

    return Object.freeze({ kind: 'already-missing', worktree: actual.worktree });
  }

  record = await transitionToRemoving(record, worktrees);
  const cleaned = await git.cleanup(actual.worktree);

  try {
    await worktrees.transitionState(record.taskId, 'REMOVING', 'REMOVED');
  } catch (error) {
    throw new TaskWorktreePersistenceError('cleanup', 'REMOVED', actual.worktree, {
      cause: error,
    });
  }

  return cleaned;
}

async function serializeTaskWorktreeOperation<Result>(
  taskId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const predecessor = taskWorktreeOperationTails.get(taskId) ?? Promise.resolve();
  let releaseOperation = (): void => undefined;
  const operationCompletion = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const tail = predecessor.then(() => operationCompletion);
  taskWorktreeOperationTails.set(taskId, tail);
  await predecessor;

  try {
    return await operation();
  } finally {
    releaseOperation();

    if (taskWorktreeOperationTails.get(taskId) === tail) {
      taskWorktreeOperationTails.delete(taskId);
    }
  }
}

async function loadContext(
  taskId: string,
  tasks: TaskRepository,
  localProjects: LocalProjectLocator,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeContext> {
  const task = await tasks.findById(taskId);

  if (task === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }

  const localProject = await localProjects.findLocalById(task.projectId);

  if (localProject === undefined) {
    throw new TaskWorktreeLifecycleError('PROJECT_NOT_LOCAL', taskId);
  }

  return Object.freeze({
    localProject,
    record: await worktrees.findByTaskId(taskId),
  });
}

async function persistProvisioning(
  worktree: TaskWorktree,
  existing: TaskWorktreeRecord | undefined,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeRecord> {
  if (existing === undefined) {
    try {
      return await worktrees.insertReservation(worktree);
    } catch (error) {
      if (!(error instanceof TaskWorktreeMetadataConflictError)) {
        throw error;
      }

      const concurrent = await worktrees.findByTaskId(worktree.taskId);

      if (concurrent === undefined || !isSameWorktree(concurrent, worktree)) {
        throw error;
      }

      throw new TaskWorktreeLifecycleError('OPERATION_IN_PROGRESS', worktree.taskId);
    }
  }

  if (!isSameWorktree(existing, worktree)) {
    throw new TaskWorktreeLifecycleError('METADATA_MISMATCH', worktree.taskId);
  }

  if (existing.lifecycleState === 'REMOVING') {
    throw new TaskWorktreeLifecycleError('OPERATION_IN_PROGRESS', worktree.taskId);
  }

  if (existing.lifecycleState === 'PROVISIONING') {
    return existing;
  }

  try {
    return await worktrees.transitionState(
      existing.taskId,
      existing.lifecycleState,
      'PROVISIONING',
    );
  } catch (error) {
    await throwIfConcurrentOperation(worktree, worktrees);
    throw error;
  }
}

async function persistPresent(
  worktree: TaskWorktree,
  existing: TaskWorktreeRecord | undefined,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeRecord> {
  let record = await persistProvisioning(worktree, existing, worktrees);

  if (record.lifecycleState !== 'PRESENT') {
    record = await transitionToPresent(record, worktrees);
  }

  return record;
}

function transitionToPresent(
  record: TaskWorktreeRecord,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeRecord> {
  return record.lifecycleState === 'PRESENT'
    ? Promise.resolve(record)
    : worktrees.transitionState(record.taskId, record.lifecycleState, 'PRESENT');
}

async function transitionToRemoving(
  record: TaskWorktreeRecord,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeRecord> {
  if (record.lifecycleState === 'PROVISIONING') {
    throw new TaskWorktreeLifecycleError('OPERATION_IN_PROGRESS', record.taskId);
  }

  if (record.lifecycleState === 'REMOVING') {
    return record;
  }

  try {
    return await worktrees.transitionState(record.taskId, record.lifecycleState, 'REMOVING');
  } catch (error) {
    await throwIfConcurrentOperation(record, worktrees);
    throw error;
  }
}

async function throwIfConcurrentOperation(
  worktree: TaskWorktree,
  worktrees: TaskWorktreeRepository,
): Promise<void> {
  const concurrent = await worktrees.findByTaskId(worktree.taskId);

  if (
    concurrent !== undefined &&
    isSameWorktree(concurrent, worktree) &&
    (concurrent.lifecycleState === 'PROVISIONING' || concurrent.lifecycleState === 'REMOVING')
  ) {
    throw new TaskWorktreeLifecycleError('OPERATION_IN_PROGRESS', worktree.taskId);
  }
}

function isSameWorktree(left: TaskWorktree, right: TaskWorktree): boolean {
  return (
    left.baseCommitId === right.baseCommitId &&
    left.baseRefName === right.baseRefName &&
    left.branchName === right.branchName &&
    left.pathIdentity === right.pathIdentity &&
    left.repositoryRootPath === right.repositoryRootPath &&
    left.taskId === right.taskId &&
    left.worktreePath === right.worktreePath
  );
}
