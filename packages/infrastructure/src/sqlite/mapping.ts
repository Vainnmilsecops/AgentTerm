import type {
  LocalProject,
  TaskWorktreeLifecycleState,
  TaskWorktreeRecord,
} from '@agentterm/application';
import {
  createAgentSession,
  createProject,
  createTask,
  TaskPhase,
  transitionTask,
  recordAgentSessionEvent,
  type AgentSession,
  type AgentSessionEvent,
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

export function mapAgentSessionRows(
  sessionRow: SqliteRow,
  eventRows: readonly SqliteRow[],
): AgentSession {
  const createdAt = readSafeNonNegativeInteger(sessionRow, 'created_at', 'Agent Session');
  let session = createAgentSession({
    agentId: readNonBlankText(sessionRow, 'agent_id', 'Agent Session'),
    createdAt,
    id: readNonBlankText(sessionRow, 'id', 'Agent Session'),
    taskId: readNonBlankText(sessionRow, 'task_id', 'Agent Session'),
  });

  if (eventRows.length === 0) {
    throw new SqlitePersistenceError('Agent Session history is empty.');
  }
  const initialRow = eventRows[0];
  if (initialRow === undefined) {
    throw new SqlitePersistenceError('Agent Session history is empty.');
  }
  assertStoredEventMatches(session.history[0], initialRow);

  for (const row of eventRows.slice(1)) {
    try {
      session = recordAgentSessionEvent(session, mapAgentSessionEventInput(row));
    } catch (error) {
      throw new SqlitePersistenceError('Agent Session history contains an invalid transition.', {
        cause: error,
      });
    }
    assertStoredEventMatches(session.history.at(-1), row);
  }

  const storedSequence = readSafePositiveInteger(sessionRow, 'history_sequence', 'Agent Session');
  const storedStatus = readText(sessionRow, 'status', 'Agent Session');
  const storedEndedAt = readNullableSafeNonNegativeInteger(sessionRow, 'ended_at', 'Agent Session');
  if (
    session.history.length !== storedSequence ||
    session.status !== storedStatus ||
    session.endedAt !== storedEndedAt
  ) {
    throw new SqlitePersistenceError('Agent Session snapshot does not match its event history.');
  }
  return session;
}

function mapAgentSessionEventInput(row: SqliteRow): Parameters<typeof recordAgentSessionEvent>[1] {
  const kind = readText(row, 'kind', 'Agent Session event');
  const occurredAt = readSafeNonNegativeInteger(row, 'occurred_at', 'Agent Session event');
  const runtimeSequence = readNullableSafePositiveInteger(
    row,
    'runtime_sequence',
    'Agent Session event',
  );
  switch (kind) {
    case 'STATUS_REPORTED': {
      const status = readText(row, 'status', 'Agent Session event');
      const source = readText(row, 'source', 'Agent Session event');
      if (
        !['IDLE', 'WAITING_INPUT', 'WORKING'].includes(status) ||
        !['APPLICATION', 'RUNTIME'].includes(source)
      ) {
        throw new SqlitePersistenceError('Agent Session status event is invalid.');
      }
      return {
        kind,
        occurredAt,
        ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
        source: source as 'APPLICATION' | 'RUNTIME',
        status: status as 'IDLE' | 'WAITING_INPUT' | 'WORKING',
      };
    }
    case 'STOP_REQUESTED':
      return { kind, occurredAt };
    case 'RUNTIME_FAILED': {
      const fatal = readInteger(row, 'fatal', 'Agent Session event');
      const stage = readText(row, 'stage', 'Agent Session event');
      if (
        ![0, 1].includes(fatal) ||
        !['CLEANUP', 'RESIZE', 'RUNTIME', 'START', 'TERMINATE', 'WRITE'].includes(stage)
      ) {
        throw new SqlitePersistenceError('Agent Session failure event is invalid.');
      }
      return {
        code: readNonBlankText(row, 'failure_code', 'Agent Session event'),
        fatal: fatal === 1,
        kind,
        occurredAt,
        ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
        stage: stage as 'CLEANUP' | 'RESIZE' | 'RUNTIME' | 'START' | 'TERMINATE' | 'WRITE',
      };
    }
    case 'PROCESS_EXITED': {
      const reason = readText(row, 'exit_reason', 'Agent Session event');
      if (runtimeSequence === undefined || !['PROCESS_EXIT', 'STOPPED'].includes(reason)) {
        throw new SqlitePersistenceError('Agent Session exit event is invalid.');
      }
      const signal = readNullableInteger(row, 'signal', 'Agent Session event');
      return {
        exitCode: readInteger(row, 'exit_code', 'Agent Session event'),
        kind,
        occurredAt,
        reason: reason as 'PROCESS_EXIT' | 'STOPPED',
        runtimeSequence,
        ...(signal === undefined ? {} : { signal }),
      };
    }
    default:
      throw new SqlitePersistenceError(`Agent Session event kind is invalid: ${kind}.`);
  }
}

function assertStoredEventMatches(event: AgentSessionEvent | undefined, row: SqliteRow): void {
  if (
    event === undefined ||
    event.sequence !== readSafePositiveInteger(row, 'sequence', 'Agent Session event') ||
    event.kind !== readText(row, 'kind', 'Agent Session event') ||
    event.status !== readText(row, 'status', 'Agent Session event') ||
    event.occurredAt !== readSafeNonNegativeInteger(row, 'occurred_at', 'Agent Session event')
  ) {
    throw new SqlitePersistenceError('Agent Session event row does not match Domain history.');
  }
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

function readInteger(row: SqliteRow, column: string, entity: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SqlitePersistenceError(`${entity} row contains an invalid ${column} integer.`);
  }
  return value;
}

function readSafeNonNegativeInteger(row: SqliteRow, column: string, entity: string): number {
  const value = readInteger(row, column, entity);
  if (value < 0) {
    throw new SqlitePersistenceError(`${entity} row contains a negative ${column}.`);
  }
  return value;
}

function readSafePositiveInteger(row: SqliteRow, column: string, entity: string): number {
  const value = readInteger(row, column, entity);
  if (value <= 0) {
    throw new SqlitePersistenceError(`${entity} row contains a nonpositive ${column}.`);
  }
  return value;
}

function readNullableInteger(row: SqliteRow, column: string, entity: string): number | undefined {
  return row[column] === null ? undefined : readInteger(row, column, entity);
}

function readNullableSafePositiveInteger(
  row: SqliteRow,
  column: string,
  entity: string,
): number | undefined {
  return row[column] === null ? undefined : readSafePositiveInteger(row, column, entity);
}

function readNullableSafeNonNegativeInteger(
  row: SqliteRow,
  column: string,
  entity: string,
): number | undefined {
  return row[column] === null ? undefined : readSafeNonNegativeInteger(row, column, entity);
}
