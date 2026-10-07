export const agentSessionOriginMigration = {
  name: 'agent-session-origin',
  version: 23,
  sql: `
    ALTER TABLE agent_sessions ADD COLUMN attempt_origin TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK (attempt_origin IN ('UNKNOWN', 'START', 'RETRY', 'RESUME'));
    ALTER TABLE agent_sessions ADD COLUMN origin_session_id TEXT
      REFERENCES agent_sessions(id)
      CHECK (
        (attempt_origin IN ('UNKNOWN', 'START') AND origin_session_id IS NULL)
        OR (attempt_origin IN ('RETRY', 'RESUME') AND origin_session_id IS NOT NULL AND origin_session_id <> id)
      );
    CREATE TRIGGER agent_session_origin_same_task BEFORE INSERT ON agent_sessions
      WHEN NEW.origin_session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_sessions AS previous
          WHERE previous.id = NEW.origin_session_id AND previous.task_id = NEW.task_id
        )
      BEGIN SELECT RAISE(ABORT, 'invalid Agent Session predecessor'); END;
    CREATE TRIGGER agent_session_origin_immutable BEFORE UPDATE OF attempt_origin, origin_session_id
      ON agent_sessions
      BEGIN SELECT RAISE(ABORT, 'immutable Agent Session origin'); END;
  `,
} as const;
