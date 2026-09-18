export const taskContextAttachmentsMigration = {
  name: 'task-context-attachments',
  version: 22,
  sql: `
    CREATE TABLE task_context_attachments (
      id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 36),
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
      mime TEXT NOT NULL CHECK(mime IN ('text/plain', 'text/markdown', 'application/json', 'image/png', 'image/jpeg', 'application/pdf')),
      size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
      digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
      created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
      FOREIGN KEY(task_id) REFERENCES tasks(id),
      FOREIGN KEY(session_id, task_id) REFERENCES agent_sessions(id, task_id)
    ) STRICT;
    CREATE INDEX task_context_task_index ON task_context_attachments(task_id, created_at, id);
    CREATE TRIGGER task_context_no_update BEFORE UPDATE ON task_context_attachments
      BEGIN SELECT RAISE(ABORT, 'immutable context metadata'); END;
    CREATE TRIGGER task_context_no_delete BEFORE DELETE ON task_context_attachments
      BEGIN SELECT RAISE(ABORT, 'immutable context metadata'); END;
    CREATE TRIGGER task_context_limit BEFORE INSERT ON task_context_attachments
      WHEN (SELECT count(*) FROM task_context_attachments WHERE task_id = NEW.task_id) >= 64
      BEGIN SELECT RAISE(ABORT, 'context count limit'); END;
  `,
} as const;
