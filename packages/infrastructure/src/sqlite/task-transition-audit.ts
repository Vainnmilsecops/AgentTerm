import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { EntityAlreadyExistsError, type TaskTransitionLog } from '@agentterm/application';
import {
  TaskPhase,
  TaskTransitionTrigger,
  type TaskTransitionAudit,
} from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';

/**
 * Append-only SQLite-backed audit log for Task phase transitions. Used by
 * `transitionTask` (Application) to record one row per accepted phase
 * change so reviewers can distinguish manual moves from automated
 * `RESEARCH_AUTO_ADVANCE` ones. Never updated or deleted in place.
 */
export class SqliteTaskTransitionLog implements TaskTransitionLog {
  private readonly appendStatement: StatementSync;
  private readonly listByTaskIdStatement: StatementSync;

  public constructor(private readonly database: DatabaseSync) {
    this.appendStatement = database.prepare(
      `INSERT INTO task_transition_audit (
         id,
         task_id,
         from_phase,
         to_phase,
         trigger_kind,
         artifact_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.listByTaskIdStatement = database.prepare(
      `SELECT id, task_id, from_phase, to_phase, trigger_kind, artifact_id, created_at
       FROM task_transition_audit
       WHERE task_id = ?
       ORDER BY created_at DESC, id DESC`,
    );
  }

  public async append(audit: TaskTransitionAudit): Promise<void> {
    try {
      this.appendStatement.run(
        audit.id,
        audit.taskId,
        audit.fromPhase,
        audit.toPhase,
        serializeTrigger(audit.trigger),
        audit.artifactId ?? null,
        audit.createdAt,
      );
    } catch (error) {
      if (isSqlitePrimaryKeyViolation(error)) {
        throw new EntityAlreadyExistsError('TaskTransitionAudit', audit.id);
      }
      throw new SqlitePersistenceError('Task Transition Audit row could not be persisted.', {
        cause: error,
      });
    }
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskTransitionAudit[]> {
    const rows = this.listByTaskIdStatement.all(taskId);
    return Object.freeze(rows.map((row) => mapAuditRow(row)));
  }
}

const sqlitePrimaryKeyConstraintCode = 1555;

function isSqlitePrimaryKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === sqlitePrimaryKeyConstraintCode) return true;
  if (typeof candidate.message === 'string' && candidate.message.includes('UNIQUE constraint failed')) {
    return true;
  }
  return false;
}

function serializeTrigger(trigger: TaskTransitionTrigger): string {
  // The CHECK constraint in the migration accepts only these literal strings.
  if (trigger === TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE) {
    return 'research-auto-advance';
  }
  return 'manual';
}

interface AuditRow {
  readonly artifact_id: unknown;
  readonly created_at: unknown;
  readonly from_phase: unknown;
  readonly id: unknown;
  readonly task_id: unknown;
  readonly to_phase: unknown;
  readonly trigger_kind: unknown;
}

function mapAuditRow(row: unknown): TaskTransitionAudit {
  if (typeof row !== 'object' || row === null) {
    throw new SqlitePersistenceError('Task Transition Audit row has an unexpected shape.');
  }
  const record = row as AuditRow;
  return Object.freeze({
    artifactId: record.artifact_id === null || record.artifact_id === undefined
      ? undefined
      : readText(record.artifact_id, 'artifact_id'),
    createdAt: readInteger(record.created_at, 'created_at'),
    fromPhase: readPhase(record.from_phase, 'from_phase'),
    id: readText(record.id, 'id'),
    taskId: readText(record.task_id, 'task_id'),
    toPhase: readPhase(record.to_phase, 'to_phase'),
    trigger: readTrigger(record.trigger_kind),
  });
}

function readText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SqlitePersistenceError(`Task Transition Audit ${field} is not text.`);
  }
  return value;
}

function readInteger(value: unknown, field: string): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new SqlitePersistenceError(`Task Transition Audit ${field} is not an integer.`);
}

function readPhase(value: unknown, field: string): TaskPhase {
  const text = readText(value, field);
  if (
    text !== TaskPhase.BACKLOG &&
    text !== TaskPhase.PLANNING &&
    text !== TaskPhase.RUNNING &&
    text !== TaskPhase.REVIEW &&
    text !== TaskPhase.DONE
  ) {
    throw new SqlitePersistenceError(`Task Transition Audit ${field} '${text}' is not a TaskPhase.`);
  }
  return text;
}

function readTrigger(value: unknown): TaskTransitionTrigger {
  const text = readText(value, 'trigger_kind');
  if (text === 'manual') return TaskTransitionTrigger.MANUAL;
  if (text === 'research-auto-advance') return TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE;
  throw new SqlitePersistenceError(`Task Transition Audit trigger_kind '${text}' is unknown.`);
}
