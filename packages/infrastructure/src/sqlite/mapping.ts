import type {
  LocalProject,
  TaskWorktreeLifecycleState,
  TaskWorktreeRecord,
} from '@agentterm/application';
import {
  createProject,
  createTask,
  TaskPhase,
  transitionTask,
  type Project,
  type Task,
  type TaskPhase as TaskPhaseValue,
} from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';

type SqliteRow = Readonly<Record<string, bigint | null | number | string | Uint8Array>>;

const taskPhaseProgression = [
  TaskPhase.BACKLOG,
  TaskPhase.PLANNING,
  TaskPhase.RUNNING,
  TaskPhase.REVIEW,
  TaskPhase.DONE,
] as const;

const taskWorktreeLifecycleStates = [
  'PROVISIONING',
  'PRESENT',
  'REMOVING',
  'REMOVED',
] as const satisfies readonly TaskWorktreeLifecycleState[];

export function mapProjectRow(row: SqliteRow): Project {
  return createProject({
    id: readText(row, 'id', 'Project'),
    name: readText(row, 'name', 'Project'),
  });
}

export function mapLocalProjectRow(row: SqliteRow): LocalProject {
  return Object.freeze({
    ...mapProjectRow(row),
    rootPath: readText(row, 'canonical_path', 'Local Project'),
  });
}

export function mapTaskRow(row: SqliteRow): Task {
  const storedPhase = readTaskPhase(row);
  let task = createTask({
    id: readText(row, 'id', 'Task'),
    projectId: readText(row, 'project_id', 'Task'),
    title: readText(row, 'title', 'Task'),
  });

  for (const phase of taskPhaseProgression) {
    if (task.phase === storedPhase) {
      return task;
    }

    if (phase !== TaskPhase.BACKLOG) {
      task = transitionTask(task, phase);
    }
  }

  if (task.phase === storedPhase) {
    return task;
  }

  throw new SqlitePersistenceError(`Task ${task.id} has an unreachable persisted phase.`);
}

export function mapTaskWorktreeRow(row: SqliteRow): TaskWorktreeRecord {
  const lifecycleState = readText(row, 'lifecycle_state', 'Task Worktree');
  const baseCommitId = readNonBlankText(row, 'base_commit_id', 'Task Worktree');

  if (!taskWorktreeLifecycleStates.some((candidate) => candidate === lifecycleState)) {
    throw new SqlitePersistenceError(
      `Task Worktree row contains an invalid lifecycle state: ${lifecycleState}.`,
    );
  }

  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(baseCommitId)) {
    throw new SqlitePersistenceError('Task Worktree row contains an invalid base commit id.');
  }

  return Object.freeze({
    baseCommitId,
    baseRefName: readNonBlankText(row, 'base_ref_name', 'Task Worktree'),
    branchName: readNonBlankText(row, 'branch_name', 'Task Worktree'),
    lifecycleState: lifecycleState as TaskWorktreeLifecycleState,
    pathIdentity: readNonBlankText(row, 'path_identity', 'Task Worktree'),
    repositoryRootPath: readNonBlankText(row, 'repository_root_path', 'Task Worktree'),
    taskId: readNonBlankText(row, 'task_id', 'Task Worktree'),
    worktreePath: readNonBlankText(row, 'worktree_path', 'Task Worktree'),
  });
}

function readTaskPhase(row: SqliteRow): TaskPhaseValue {
  const phase = readText(row, 'phase', 'Task');

  if (!taskPhaseProgression.some((candidate) => candidate === phase)) {
    throw new SqlitePersistenceError(`Task row contains an invalid phase: ${phase}.`);
  }

  return phase as TaskPhaseValue;
}

function readText(row: SqliteRow, column: string, entity: string): string {
  const value = row[column];

  if (typeof value !== 'string') {
    throw new SqlitePersistenceError(`${entity} row contains a non-text ${column} column.`);
  }

  return value;
}

function readNonBlankText(row: SqliteRow, column: string, entity: string): string {
  const value = readText(row, column, entity);

  if (value.trim().length === 0) {
    throw new SqlitePersistenceError(`${entity} row contains a blank ${column} column.`);
  }

  return value;
}
