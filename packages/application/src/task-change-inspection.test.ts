import { describe, expect, it, vi } from 'vitest';

import { TaskPhase, createTask, transitionTask, type Task } from '@agentterm/domain';

import {
  getTaskFileDiff,
  listTaskChanges,
  type TaskChangeInspector,
  type TaskRepository,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from './index';

const task = transitionTask(
  transitionTask(
    createTask({ id: 'task-1', projectId: 'project-1', title: 'Inspect changes' }),
    TaskPhase.PLANNING,
  ),
  TaskPhase.RUNNING,
);

const worktree: TaskWorktreeRecord = Object.freeze({
  baseCommitId: 'a'.repeat(40),
  baseRefName: 'refs/heads/main',
  branchName: 'agentterm/task/change-inspection',
  lifecycleState: 'PRESENT',
  pathIdentity: 'sha256:worktree',
  repositoryRootPath: 'D:\\Repositories\\AgentTerm',
  taskId: task.id,
  worktreePath: 'D:\\Worktrees\\task-1',
});

const changes = Object.freeze({
  files: Object.freeze([
    Object.freeze({
      area: 'UNSTAGED' as const,
      kind: 'MODIFIED' as const,
      path: 'src/change.ts',
    }),
  ]),
  totalFiles: 1,
  truncated: false,
});

const diff = Object.freeze({
  additions: 2,
  area: 'UNSTAGED' as const,
  binary: false,
  deletions: 1,
  kind: 'MODIFIED' as const,
  patch: Object.freeze({ text: 'diff --git a/src/change.ts b/src/change.ts\n', truncated: false }),
  path: 'src/change.ts',
});

describe('Task Change inspection use cases', () => {
  it('lists bounded changes from the exact persisted primary Worktree without changing Task state', async () => {
    const inspector = createInspector();
    const tasks = taskRepository(task);

    await expect(
      listTaskChanges({ taskId: task.id }, tasks, worktreeRepository(worktree), inspector),
    ).resolves.toEqual(changes);

    expect(inspector.listChanges).toHaveBeenCalledWith(worktree);
    await expect(tasks.findById(task.id)).resolves.toEqual(task);
  });

  it('loads one selected file diff lazily through the same verified Worktree', async () => {
    const inspector = createInspector();

    await expect(
      getTaskFileDiff(
        { area: 'UNSTAGED', path: 'src/change.ts', taskId: task.id },
        taskRepository(task),
        worktreeRepository(worktree),
        inspector,
      ),
    ).resolves.toEqual(diff);

    expect(inspector.getFileDiff).toHaveBeenCalledWith(worktree, {
      area: 'UNSTAGED',
      path: 'src/change.ts',
    });
  });

  it('rejects a missing or non-PRESENT Worktree before invoking Git', async () => {
    for (const record of [undefined, { ...worktree, lifecycleState: 'REMOVED' as const }]) {
      const inspector = createInspector();

      await expect(
        listTaskChanges(
          { taskId: task.id },
          taskRepository(task),
          worktreeRepository(record),
          inspector,
        ),
      ).rejects.toMatchObject({
        name: 'TaskChangeInspectionError',
        reason: 'WORKTREE_NOT_READY',
        taskId: task.id,
      });

      expect(inspector.listChanges).not.toHaveBeenCalled();
    }
  });

  it('rejects a missing Task before reading Worktree metadata', async () => {
    const worktrees = worktreeRepository(worktree);

    await expect(
      listTaskChanges(
        { taskId: 'missing-task' },
        taskRepository(undefined),
        worktrees,
        createInspector(),
      ),
    ).rejects.toMatchObject({ entity: 'Task', id: 'missing-task' });

    expect(worktrees.findByTaskId).not.toHaveBeenCalled();
  });
});

function createInspector(): TaskChangeInspector & {
  readonly getFileDiff: ReturnType<typeof vi.fn<TaskChangeInspector['getFileDiff']>>;
  readonly listChanges: ReturnType<typeof vi.fn<TaskChangeInspector['listChanges']>>;
} {
  return {
    getFileDiff: vi.fn(async () => diff),
    listChanges: vi.fn(async () => changes),
  };
}

function taskRepository(value: Task | undefined): TaskRepository {
  return {
    findById: async (id) => (value?.id === id ? value : undefined),
    insert: async () => undefined,
    update: async () => undefined,
  };
}

function worktreeRepository(value: TaskWorktreeRecord | undefined): TaskWorktreeRepository & {
  readonly findByTaskId: ReturnType<typeof vi.fn<TaskWorktreeRepository['findByTaskId']>>;
} {
  return {
    findByTaskId: vi.fn(async (taskId) => (value?.taskId === taskId ? value : undefined)),
    insertReservation: async () => {
      throw new Error('Change inspection must not reserve a Worktree.');
    },
    transitionState: async () => {
      throw new Error('Change inspection must not mutate Worktree state.');
    },
  };
}
