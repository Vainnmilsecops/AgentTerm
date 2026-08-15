import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  validateWorkspaceLayoutRecord,
  WorkspaceLayoutConflictError,
  type WorkspaceLayoutReadModel,
  type WorkspaceLayoutRecord,
  type WorkspaceLayoutRepository,
} from '@agentterm/application';

import { SqlitePersistenceError } from './errors';

export type { WorkspaceLayoutReadModel };

export class SqliteWorkspaceLayoutRepository implements WorkspaceLayoutRepository {
  private readonly database: DatabaseSync;
  private readonly insertStatement: StatementSync;
  private readonly readStatement: StatementSync;
  private readonly updateStatement: StatementSync;

  public constructor(database: DatabaseSync) {
    this.database = database;
    this.readStatement = database.prepare(
      `SELECT schema_version, revision, updated_at, layout_json
       FROM workspace_layout WHERE singleton_id = 1`,
    );
    this.insertStatement = database.prepare(
      `INSERT INTO workspace_layout (
        singleton_id, schema_version, revision, updated_at, layout_json
       ) VALUES (1, 1, ?, ?, ?)`,
    );
    this.updateStatement = database.prepare(
      `UPDATE workspace_layout
       SET schema_version = 1, revision = ?, updated_at = ?, layout_json = ?
       WHERE singleton_id = 1 AND revision = ?`,
    );
  }

  public async load(): Promise<WorkspaceLayoutReadModel | undefined> {
    const row = this.readStatement.get();
    if (row === undefined) return undefined;
    return mapRow(row);
  }

  public async save(input: {
    readonly expectedRevision: number;
    readonly layout: WorkspaceLayoutRecord;
  }): Promise<WorkspaceLayoutReadModel> {
    const validated = validateWorkspaceLayoutRecord(input.layout);
    const nextRevision = input.expectedRevision + 1;
    const updatedAt = Date.now();
    const payload = JSON.stringify(validated.layout);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.readStatement.get();
      if (existing === undefined) {
        if (input.expectedRevision !== 0) {
          throw new WorkspaceLayoutConflictError();
        }
        this.insertStatement.run(nextRevision, updatedAt, payload);
      } else {
        const storedRevision = readInteger(existing.revision);
        if (storedRevision !== input.expectedRevision) {
          throw new WorkspaceLayoutConflictError();
        }
        const result = this.updateStatement.run(
          nextRevision,
          updatedAt,
          payload,
          input.expectedRevision,
        );
        if (result.changes !== 1 && result.changes !== 1n) {
          throw new WorkspaceLayoutConflictError();
        }
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (error instanceof WorkspaceLayoutConflictError) throw error;
      throw new SqlitePersistenceError('Workspace Layout could not be persisted.', {
        cause: error,
      });
    }
    return {
      layout: validated.layout,
      revision: nextRevision,
      updatedAt,
    };
  }
}

function mapRow(row: Record<string, unknown>): WorkspaceLayoutReadModel {
  const layoutJson = readText(row.layout_json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(layoutJson);
  } catch (error) {
    throw new SqlitePersistenceError('Workspace Layout JSON is corrupt.', { cause: error });
  }
  let validated;
  try {
    validated = validateWorkspaceLayoutRecord(parsed);
  } catch (error) {
    throw new SqlitePersistenceError('Workspace Layout is invalid.', { cause: error });
  }
  return Object.freeze({
    layout: validated.layout,
    revision: readInteger(row.revision),
    updatedAt: readInteger(row.updated_at),
  });
}

function readText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SqlitePersistenceError('Workspace Layout text is not a string.');
  }
  return value;
}

function readInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SqlitePersistenceError('Workspace Layout integer is invalid.');
  }
  return value;
}
