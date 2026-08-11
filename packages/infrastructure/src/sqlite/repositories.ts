import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  EntityAlreadyExistsError,
  type LocalProject,
  type LocalProjectLocator,
  type ProjectCatalog,
  type ProjectRepository,
  type RecordProjectOpenInput,
  type TaskRepository,
  TaskWorktreeMetadataConflictError,
  type TaskWorktree,
  type TaskWorktreeLifecycleState,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from '@agentterm/application';
import type { Project, Task } from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';
import { mapLocalProjectRow, mapProjectRow, mapTaskRow, mapTaskWorktreeRow } from './mapping';

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

export class SqliteTaskRepository implements TaskRepository {
  private readonly findByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly updateStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.findByIdStatement = database.prepare(
      'SELECT id, project_id, title, phase FROM tasks WHERE id = ?',
    );
    this.insertStatement = database.prepare(
      'INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)',
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
