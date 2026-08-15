import type { DatabaseSync, StatementSync } from "node:sqlite";

import {
  type WorkflowPluginBindingRecord,
  type WorkflowPluginBindingRepository,
  WorkflowPluginConflictError,
  WorkflowPluginValidationError,
} from "@agentterm/application";

import { SqlitePersistenceError } from "./errors";

interface WorkflowPluginBindingRow {
  readonly active_phase_id: string;
  readonly installed_at: number;
  readonly plugin_id: string;
  readonly revision: number;
  readonly source_path: string;
  readonly task_id: string;
}

export class SqliteWorkflowPluginBindingRepository implements WorkflowPluginBindingRepository {
  private readonly findStatement: StatementSync;
  private readonly insertStatement: StatementSync;
  private readonly updateStatement: StatementSync;
  private readonly removeStatement: StatementSync;

  public constructor(private readonly database: DatabaseSync) {
    this.findStatement = database.prepare(
      `SELECT task_id, plugin_id, source_path, active_phase_id, revision, installed_at
       FROM workflow_plugin_bindings WHERE task_id = ?`,
    );
    this.insertStatement = database.prepare(
      `INSERT INTO workflow_plugin_bindings (
         task_id, plugin_id, source_path, active_phase_id, revision, installed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.updateStatement = database.prepare(
      `UPDATE workflow_plugin_bindings
       SET plugin_id = ?, source_path = ?, active_phase_id = ?,
           revision = ?, installed_at = ?
       WHERE task_id = ? AND revision = ?`,
    );
    this.removeStatement = database.prepare(
      "DELETE FROM workflow_plugin_bindings WHERE task_id = ?",
    );
  }

  public async findByTaskId(
    taskId: string,
  ): Promise<WorkflowPluginBindingRecord | undefined> {
    const row = this.findStatement.get(taskId) as
      WorkflowPluginBindingRow | undefined;
    if (row === undefined) return undefined;
    return mapBinding(row);
  }

  public async upsert(
    record: WorkflowPluginBindingRecord,
    expectedRevision: number,
  ): Promise<void> {
    const previous = await this.findByTaskId(record.taskId);
    if (previous === undefined) {
      if (expectedRevision !== 0) {
        throw new WorkflowPluginConflictError();
      }
      try {
        const result = this.insertStatement.run(
          record.taskId,
          record.pluginId,
          record.sourcePath,
          record.activePhaseId,
          record.revision,
          record.installedAt,
        );
        if (Number(result.changes) !== 1) {
          throw new WorkflowPluginConflictError();
        }
        return;
      } catch (error) {
        this.wrapInsertError(error, record.taskId);
      }
    }
    if (previous.revision !== expectedRevision) {
      throw new WorkflowPluginConflictError();
    }
    try {
      const result = this.updateStatement.run(
        record.pluginId,
        record.sourcePath,
        record.activePhaseId,
        record.revision,
        record.installedAt,
        record.taskId,
        expectedRevision,
      );
      if (Number(result.changes) !== 1) {
        throw new WorkflowPluginConflictError();
      }
    } catch (error) {
      this.wrapUpdateError(error);
    }
  }

  public async removeByTaskId(taskId: string): Promise<boolean> {
    try {
      const result = this.removeStatement.run(taskId);
      return Number(result.changes) > 0;
    } catch (error) {
      throw new SqlitePersistenceError(
        "Workflow Plugin binding could not be removed.",
        {
          cause: error,
        },
      );
    }
  }

  private wrapInsertError(error: unknown, taskId: string): never {
    if (error instanceof WorkflowPluginConflictError) {
      throw error;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (message.includes("constraint")) {
      throw new WorkflowPluginValidationError(
        "Workflow Plugin binding failed validation",
        {
          taskId,
        },
      );
    }
    throw new SqlitePersistenceError(
      "Workflow Plugin binding could not be persisted.",
      {
        cause: error,
      },
    );
  }

  private wrapUpdateError(error: unknown): never {
    if (error instanceof WorkflowPluginConflictError) {
      throw error;
    }
    throw new SqlitePersistenceError(
      "Workflow Plugin binding could not be persisted.",
      {
        cause: error,
      },
    );
  }
}

function mapBinding(
  row: WorkflowPluginBindingRow,
): WorkflowPluginBindingRecord {
  return Object.freeze({
    activePhaseId: row.active_phase_id,
    installedAt: row.installed_at,
    pluginId: row.plugin_id,
    revision: row.revision,
    sourcePath: row.source_path,
    taskId: row.task_id,
  });
}
