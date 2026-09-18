import type { DatabaseSync } from 'node:sqlite';
import {
  TaskContextError,
  type TaskContextAttachment,
  type TaskContextRepository,
} from '@agentterm/application';

export class SqliteTaskContextRepository implements TaskContextRepository {
  constructor(private readonly database: DatabaseSync) {}
  async insertBatch(items: readonly TaskContextAttachment[]): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.database.prepare(
        'INSERT INTO task_context_attachments (id, task_id, session_id, name, mime, size, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const item of items)
        insert.run(
          item.id,
          item.taskId,
          item.sessionId,
          item.name,
          item.mime,
          item.size,
          item.digest,
          item.createdAt,
        );
      this.database.exec('COMMIT');
    } catch {
      this.database.exec('ROLLBACK');
      throw new TaskContextError('SAVE_FAILED');
    }
  }
  async listByTaskId(taskId: string): Promise<readonly TaskContextAttachment[]> {
    const rows = this.database
      .prepare('SELECT * FROM task_context_attachments WHERE task_id = ? ORDER BY created_at, id')
      .all(taskId);
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: String(row.id),
          taskId: String(row.task_id),
          sessionId: String(row.session_id),
          name: String(row.name),
          mime: String(row.mime),
          size: Number(row.size),
          digest: String(row.digest),
          createdAt: Number(row.created_at),
        }),
      ),
    );
  }
}
