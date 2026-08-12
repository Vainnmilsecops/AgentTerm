import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  type AgentSessionRepository,
  AgentSessionActiveConflictError,
  EntityAlreadyExistsError,
  type LocalProject,
  type LocalProjectLocator,
  type ProjectCatalog,
  type ProjectRepository,
  type RecordProjectOpenInput,
  type TaskRepository,
  type TaskCatalog,
  TaskWorktreeMetadataConflictError,
  type TaskWorktree,
  type TaskWorktreeLifecycleState,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from '@agentterm/application';
import type { AgentSession, AgentSessionEvent, Project, Task } from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';
import {
  mapAgentSessionRows,
  mapLocalProjectRow,
  mapProjectRow,
  mapTaskRow,
  mapTaskWorktreeRow,
} from './mapping';

const primaryKeyConstraintCode = 1555;
const uniqueConstraintCode = 2067;

export class SqliteProjectRepository
  implements LocalProjectLocator, ProjectCatalog, ProjectRepository
{
  private readonly database: DatabaseSync;
  private readonly findByIdStatement: StatementSync;
  private readonly findByPathIdentityStatement: StatementSync;
  private readonly findLocalByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly insertRootStatement: StatementSync;
  private readonly listRecentStatement: StatementSync;
  private readonly nextOpenedOrderStatement: StatementSync;
  private readonly touchRootStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findByIdStatement = database.prepare('SELECT id, name FROM projects WHERE id = ?');
    this.findLocalByIdStatement = database.prepare(
      `SELECT projects.id, projects.name, project_roots.canonical_path
       FROM project_roots
       INNER JOIN projects ON projects.id = project_roots.project_id
       WHERE projects.id = ?`,
    );
    this.findByPathIdentityStatement = database.prepare(
      `SELECT projects.id, projects.name, project_roots.canonical_path
       FROM project_roots
       INNER JOIN projects ON projects.id = project_roots.project_id
       WHERE project_roots.path_identity = ?`,
    );
    this.insertStatement = database.prepare('INSERT INTO projects (id, name) VALUES (?, ?)');
    this.insertRootStatement = database.prepare(
      `INSERT INTO project_roots (
         project_id,
         canonical_path,
         path_identity,
         last_opened_order
       ) VALUES (?, ?, ?, ?)`,
    );
    this.listRecentStatement = database.prepare(
      `SELECT projects.id, projects.name, project_roots.canonical_path
       FROM project_roots
       INNER JOIN projects ON projects.id = project_roots.project_id
       ORDER BY project_roots.last_opened_order DESC, projects.id`,
    );
    this.nextOpenedOrderStatement = database.prepare(
      `SELECT COALESCE(MAX(last_opened_order), 0) + 1 AS next_order
       FROM project_roots`,
    );
    this.touchRootStatement = database.prepare(
      `UPDATE project_roots
       SET last_opened_order = ?
       WHERE project_id = ?`,
    );
  }

  public async findById(id: string): Promise<Project | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapProjectRow(row);
  }

  public async findLocalById(id: string): Promise<LocalProject | undefined> {
    const row = this.findLocalByIdStatement.get(id);
    return row === undefined ? undefined : mapLocalProjectRow(row);
  }

  public async insert(project: Project): Promise<void> {
    try {
      this.insertStatement.run(project.id, project.name);
    } catch (error) {
      if (isSqliteErrorCode(error, primaryKeyConstraintCode)) {
        throw new EntityAlreadyExistsError('Project', project.id);
      }

      throw error;
    }
  }

  public async recordOpen(input: RecordProjectOpenInput): Promise<LocalProject> {
    this.database.exec('BEGIN IMMEDIATE');

    try {
      const existingRoot = this.findByPathIdentityStatement.get(input.pathIdentity);
      const nextOpenedOrder = this.readNextOpenedOrder();

      if (existingRoot === undefined) {
        if (this.findByIdStatement.get(input.project.id) === undefined) {
          this.insertStatement.run(input.project.id, input.project.name);
        }

        this.insertRootStatement.run(
          input.project.id,
          input.rootPath,
          input.pathIdentity,
          nextOpenedOrder,
        );
      } else {
        const existingProject = mapLocalProjectRow(existingRoot);
        this.touchRootStatement.run(nextOpenedOrder, existingProject.id);
      }

      const storedRoot = this.findByPathIdentityStatement.get(input.pathIdentity);

      if (storedRoot === undefined) {
        throw new SqlitePersistenceError('Recorded Project root could not be read back.');
      }

      const localProject = mapLocalProjectRow(storedRoot);
      this.database.exec('COMMIT');
      return localProject;
    } catch (error) {
      this.database.exec('ROLLBACK');

      if (error instanceof SqlitePersistenceError) {
        throw error;
      }

      throw new SqlitePersistenceError('Failed to record Project open.', { cause: error });
    }
  }

  public async listRecent(): Promise<readonly LocalProject[]> {
    return this.listRecentStatement.all().map(mapLocalProjectRow);
  }

  private readNextOpenedOrder(): number {
    const row = this.nextOpenedOrderStatement.get();
    const nextOpenedOrder = row?.next_order;

    if (
      typeof nextOpenedOrder !== 'number' ||
      !Number.isSafeInteger(nextOpenedOrder) ||
      nextOpenedOrder <= 0
    ) {
      throw new SqlitePersistenceError('Could not allocate the next Project open order.');
    }

    return nextOpenedOrder;
  }
}

export class SqliteTaskRepository implements TaskCatalog, TaskRepository {
  private readonly findByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly listByProjectIdStatement: StatementSync;
  private readonly updateStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.findByIdStatement = database.prepare(
      'SELECT id, project_id, title, phase FROM tasks WHERE id = ?',
    );
    this.insertStatement = database.prepare(
      'INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)',
    );
    this.listByProjectIdStatement = database.prepare(
      'SELECT id, project_id, title, phase FROM tasks WHERE project_id = ? ORDER BY id',
    );
    this.updateStatement = database.prepare(
      'UPDATE tasks SET project_id = ?, title = ?, phase = ? WHERE id = ?',
    );
  }

  public async findById(id: string): Promise<Task | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapTaskRow(row);
  }

  public async insert(task: Task): Promise<void> {
    try {
      this.insertStatement.run(task.id, task.projectId, task.title, task.phase);
    } catch (error) {
      if (isSqliteErrorCode(error, primaryKeyConstraintCode)) {
        throw new EntityAlreadyExistsError('Task', task.id);
      }

      throw error;
    }
  }

  public async listByProjectId(projectId: string): Promise<readonly Task[]> {
    return this.listByProjectIdStatement.all(projectId).map(mapTaskRow);
  }

  public async update(task: Task): Promise<void> {
    const result = this.updateStatement.run(task.projectId, task.title, task.phase, task.id);

    if (result.changes === 0 || result.changes === 0n) {
      throw new SqlitePersistenceError(`Cannot update missing Task ${task.id}.`);
    }
  }
}

export class SqliteTaskWorktreeRepository implements TaskWorktreeRepository {
  private readonly findByTaskIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly transitionStateStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.findByTaskIdStatement = database.prepare(
      `SELECT
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state
       FROM task_worktrees
       WHERE task_id = ?`,
    );
    this.insertStatement = database.prepare(
      `INSERT INTO task_worktrees (
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PROVISIONING')
       RETURNING
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state`,
    );
    this.transitionStateStatement = database.prepare(
      `UPDATE task_worktrees
       SET lifecycle_state = ?
       WHERE task_id = ? AND lifecycle_state = ?
       RETURNING
         task_id,
         repository_root_path,
         worktree_path,
         path_identity,
         branch_name,
         base_ref_name,
         base_commit_id,
         lifecycle_state`,
    );
  }

  public async findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined> {
    const row = this.findByTaskIdStatement.get(taskId);
    return row === undefined ? undefined : mapTaskWorktreeRow(row);
  }

  public async insertReservation(worktree: TaskWorktree): Promise<TaskWorktreeRecord> {
    if (!isGitObjectId(worktree.baseCommitId)) {
      throw new SqlitePersistenceError('Task Worktree base commit id is invalid.');
    }

    let row: ReturnType<StatementSync['get']>;

    try {
      row = this.insertStatement.get(
        worktree.taskId,
        worktree.repositoryRootPath,
        worktree.worktreePath,
        worktree.pathIdentity,
        worktree.branchName,
        worktree.baseRefName,
        worktree.baseCommitId,
      );
    } catch (error) {
      if (isSqliteMetadataConflictError(error)) {
        throw new TaskWorktreeMetadataConflictError(worktree.taskId, { cause: error });
      }

      throw new SqlitePersistenceError('Failed to reserve Task Worktree metadata.', {
        cause: error,
      });
    }

    if (row === undefined) {
      throw new SqlitePersistenceError('Task Worktree reservation was not returned after insert.');
    }

    return mapTaskWorktreeRow(row);
  }

  public async transitionState(
    taskId: string,
    expectedState: TaskWorktreeLifecycleState,
    nextState: TaskWorktreeLifecycleState,
  ): Promise<TaskWorktreeRecord> {
    let row: ReturnType<StatementSync['get']>;

    try {
      row = this.transitionStateStatement.get(nextState, taskId, expectedState);
    } catch (error) {
      throw new SqlitePersistenceError('Failed to transition Task Worktree metadata.', {
        cause: error,
      });
    }

    if (row === undefined) {
      throw new TaskWorktreeMetadataConflictError(taskId);
    }

    return mapTaskWorktreeRow(row);
  }
}

export class SqliteAgentSessionRepository implements AgentSessionRepository {
  private readonly database: DatabaseSync;
  private readonly appendSnapshotStatement: StatementSync;
  private readonly eventsBySessionIdStatement: StatementSync;
  private readonly findByIdStatement: StatementSync;
  private readonly insertEventStatement: StatementSync;
  private readonly insertSessionStatement: StatementSync;
  private readonly activeByTaskIdStatement: StatementSync;
  private readonly listActiveStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;
  private readonly nextOrdinalStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.findByIdStatement = database.prepare(
      `SELECT id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
       FROM agent_sessions WHERE id = ?`,
    );
    this.listByTaskIdStatement = database.prepare(
      `SELECT id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
       FROM agent_sessions WHERE task_id = ? ORDER BY ordinal`,
    );
    this.listActiveStatement = database.prepare(
      `SELECT id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
       FROM agent_sessions
       WHERE status IN ('STARTING', 'WORKING', 'IDLE', 'WAITING_INPUT')
       ORDER BY task_id, ordinal`,
    );
    this.activeByTaskIdStatement = database.prepare(
      `SELECT id FROM agent_sessions
       WHERE task_id = ? AND status IN ('STARTING', 'WORKING', 'IDLE', 'WAITING_INPUT')
       LIMIT 1`,
    );
    this.eventsBySessionIdStatement = database.prepare(
      `SELECT
         session_id, sequence, kind, status, occurred_at, runtime_sequence,
         source, failure_code, fatal, stage, exit_code, exit_reason, signal
       FROM agent_session_events WHERE session_id = ? ORDER BY sequence`,
    );
    this.nextOrdinalStatement = database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
       FROM agent_sessions WHERE task_id = ?`,
    );
    this.insertSessionStatement = database.prepare(
      `INSERT INTO agent_sessions (
         id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertEventStatement = database.prepare(
      `INSERT INTO agent_session_events (
         session_id, sequence, kind, status, occurred_at, runtime_sequence,
         source, failure_code, fatal, stage, exit_code, exit_reason, signal
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.appendSnapshotStatement = database.prepare(
      `UPDATE agent_sessions
       SET status = ?, ended_at = ?, history_sequence = ?
       WHERE id = ? AND history_sequence = ?`,
    );
  }

  public async findById(id: string): Promise<AgentSession | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : this.mapSession(row);
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return this.listByTaskIdStatement.all(taskId).map((row) => this.mapSession(row));
  }

  public async listActive(): Promise<readonly AgentSession[]> {
    return this.listActiveStatement.all().map((row) => this.mapSession(row));
  }

  public async insert(session: AgentSession): Promise<void> {
    assertInitialSession(session);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.findByIdStatement.get(session.id) !== undefined) {
        throw new EntityAlreadyExistsError('AgentSession', session.id);
      }
      if (this.activeByTaskIdStatement.get(session.taskId) !== undefined) {
        throw new AgentSessionActiveConflictError(session.taskId);
      }
      const ordinalRow = this.nextOrdinalStatement.get(session.taskId);
      const ordinal = ordinalRow?.next_ordinal;
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
        throw new SqlitePersistenceError('Could not allocate the next Agent Session ordinal.');
      }
      this.insertSessionStatement.run(
        session.id,
        session.taskId,
        session.agentId,
        ordinal,
        session.status,
        session.createdAt,
        session.endedAt ?? null,
        session.history.length,
      );
      const initialEvent = session.history[0];
      if (initialEvent === undefined) {
        throw new SqlitePersistenceError('New Agent Session history is empty.');
      }
      this.insertEvent(session.id, initialEvent);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (
        error instanceof AgentSessionActiveConflictError ||
        error instanceof EntityAlreadyExistsError ||
        error instanceof SqlitePersistenceError
      ) {
        throw error;
      }
      if (isSqliteMetadataConflictError(error)) {
        throw new EntityAlreadyExistsError('AgentSession', session.id);
      }
      throw new SqlitePersistenceError('Failed to insert Agent Session.', { cause: error });
    }
  }

  public async append(session: AgentSession, expectedSequence: number): Promise<void> {
    if (
      !Number.isSafeInteger(expectedSequence) ||
      expectedSequence <= 0 ||
      session.history.length !== expectedSequence + 1
    ) {
      throw new SqlitePersistenceError('Agent Session append revision is invalid.');
    }
    const event = session.history.at(-1);
    if (event === undefined || event.sequence !== session.history.length) {
      throw new SqlitePersistenceError('Agent Session append event is invalid.');
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const storedRow = this.findByIdStatement.get(session.id);
      if (storedRow === undefined) {
        throw new SqlitePersistenceError('Agent Session append target is missing.');
      }
      const stored = this.mapSession(storedRow);
      if (
        stored.id !== session.id ||
        stored.taskId !== session.taskId ||
        stored.agentId !== session.agentId ||
        stored.createdAt !== session.createdAt ||
        stored.history.length !== expectedSequence ||
        !stored.history.every(
          (storedEvent, index) =>
            JSON.stringify(storedEvent) === JSON.stringify(session.history[index]),
        )
      ) {
        throw new SqlitePersistenceError('Agent Session append history does not match storage.');
      }
      const result = this.appendSnapshotStatement.run(
        session.status,
        session.endedAt ?? null,
        session.history.length,
        session.id,
        expectedSequence,
      );
      if (result.changes === 0 || result.changes === 0n) {
        throw new SqlitePersistenceError('Agent Session append revision is stale.');
      }
      this.insertEvent(session.id, event);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof SqlitePersistenceError) {
        throw error;
      }
      throw new SqlitePersistenceError('Failed to append Agent Session history.', {
        cause: error,
      });
    }
  }

  private mapSession(row: ReturnType<StatementSync['get']>): AgentSession {
    if (row === undefined || typeof row.id !== 'string') {
      throw new SqlitePersistenceError('Agent Session row is invalid.');
    }
    return mapAgentSessionRows(row, this.eventsBySessionIdStatement.all(row.id));
  }

  private insertEvent(sessionId: string, event: AgentSessionEvent): void {
    const values = serializeAgentSessionEvent(event);
    this.insertEventStatement.run(
      sessionId,
      event.sequence,
      event.kind,
      event.status,
      event.occurredAt,
      values.runtimeSequence,
      values.source,
      values.failureCode,
      values.fatal,
      values.stage,
      values.exitCode,
      values.exitReason,
      values.signal,
    );
  }
}

function assertInitialSession(session: AgentSession): void {
  if (
    session.status !== 'STARTING' ||
    session.endedAt !== undefined ||
    session.history.length !== 1 ||
    session.history[0]?.kind !== 'START_REQUESTED'
  ) {
    throw new SqlitePersistenceError('New Agent Session must contain only STARTING history.');
  }
}

interface SerializedAgentSessionEvent {
  readonly exitCode: number | null;
  readonly exitReason: string | null;
  readonly failureCode: string | null;
  readonly fatal: number | null;
  readonly runtimeSequence: number | null;
  readonly signal: number | null;
  readonly source: string | null;
  readonly stage: string | null;
}

function serializeAgentSessionEvent(event: AgentSessionEvent): SerializedAgentSessionEvent {
  return {
    exitCode: event.kind === 'PROCESS_EXITED' ? event.exitCode : null,
    exitReason: event.kind === 'PROCESS_EXITED' ? event.reason : null,
    failureCode: event.kind === 'RUNTIME_FAILED' ? event.code : null,
    fatal: event.kind === 'RUNTIME_FAILED' ? Number(event.fatal) : null,
    runtimeSequence:
      'runtimeSequence' in event && event.runtimeSequence !== undefined
        ? event.runtimeSequence
        : null,
    signal: event.kind === 'PROCESS_EXITED' ? (event.signal ?? null) : null,
    source: event.kind === 'STATUS_REPORTED' ? event.source : null,
    stage: event.kind === 'RUNTIME_FAILED' ? event.stage : null,
  };
}

function isSqliteErrorCode(error: unknown, code: number): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    error.errcode === code
  );
}

function isSqliteMetadataConflictError(error: unknown): boolean {
  return (
    isSqliteErrorCode(error, primaryKeyConstraintCode) ||
    isSqliteErrorCode(error, uniqueConstraintCode)
  );
}

function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}
