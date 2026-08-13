import { EntityNotFoundError, TaskChangeInspectionError } from './errors';
import type {
  TaskChangeInspector,
  TaskChangeSet,
  TaskFileDiff,
  TaskFileDiffRequest,
  TaskRepository,
  TaskWorktreeRecord,
  TaskWorktreeRepository,
} from './ports';

export interface ListTaskChangesInput {
  readonly taskId: string;
}

export interface GetTaskFileDiffInput extends TaskFileDiffRequest {
  readonly taskId: string;
}

export async function listTaskChanges(
  input: ListTaskChangesInput,
  tasks: TaskRepository,
  worktrees: TaskWorktreeRepository,
  inspector: TaskChangeInspector,
): Promise<TaskChangeSet> {
  const worktree = await requirePresentTaskWorktree(input.taskId, tasks, worktrees);
  return inspector.listChanges(worktree);
}

export async function getTaskFileDiff(
  input: GetTaskFileDiffInput,
  tasks: TaskRepository,
  worktrees: TaskWorktreeRepository,
  inspector: TaskChangeInspector,
): Promise<TaskFileDiff> {
  const worktree = await requirePresentTaskWorktree(input.taskId, tasks, worktrees);
  return inspector.getFileDiff(worktree, {
    area: input.area,
    path: input.path,
    ...(input.previousPath === undefined ? {} : { previousPath: input.previousPath }),
  });
}

async function requirePresentTaskWorktree(
  taskId: string,
  tasks: TaskRepository,
  worktrees: TaskWorktreeRepository,
): Promise<TaskWorktreeRecord> {
  if ((await tasks.findById(taskId)) === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  const worktree = await worktrees.findByTaskId(taskId);
  if (worktree?.lifecycleState !== 'PRESENT') {
    throw new TaskChangeInspectionError('WORKTREE_NOT_READY', taskId);
  }
  return worktree;
}
