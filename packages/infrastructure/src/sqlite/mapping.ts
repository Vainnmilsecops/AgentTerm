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

export function mapProjectRow(row: SqliteRow): Project {
  return createProject({
    id: readText(row, 'id', 'Project'),
    name: readText(row, 'name', 'Project'),
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
