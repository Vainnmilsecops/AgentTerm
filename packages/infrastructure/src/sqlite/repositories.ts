import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  EntityAlreadyExistsError,
  type ProjectRepository,
  type TaskRepository,
} from '@agentterm/application';
import type { Project, Task } from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';
import { mapProjectRow, mapTaskRow } from './mapping';

const primaryKeyConstraintCode = 1555;

export class SqliteProjectRepository implements ProjectRepository {
  private readonly findByIdStatement: StatementSync;
  private readonly insertStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.findByIdStatement = database.prepare('SELECT id, name FROM projects WHERE id = ?');
    this.insertStatement = database.prepare('INSERT INTO projects (id, name) VALUES (?, ?)');
  }

  public async findById(id: string): Promise<Project | undefined> {
    const row = this.findByIdStatement.get(id);
    return row === undefined ? undefined : mapProjectRow(row);
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

function isSqliteErrorCode(error: unknown, code: number): boolean {
  return (
    error instanceof Error &&
    'errcode' in error &&
    typeof error.errcode === 'number' &&
    error.errcode === code
  );
}
