export const executionArtifactsMigration = {
  name: 'execution-artifacts',
  sql: `
    CREATE UNIQUE INDEX agent_sessions_identity_task_index
      ON agent_sessions(id, task_id);

    CREATE TABLE execution_artifacts (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0),
      session_id TEXT CHECK (session_id IS NULL OR length(trim(session_id)) > 0),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'execution-summary', 'review')),
      phase TEXT NOT NULL CHECK (phase IN ('PLANNING', 'RUNNING', 'REVIEW')),
      canonical_name TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format = 'markdown'),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      validation TEXT NOT NULL CHECK (validation = 'VALID'),
      content TEXT NOT NULL CHECK (length(content) > 0 AND length(content) <= 1048576),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      FOREIGN KEY (session_id, task_id)
        REFERENCES agent_sessions(id, task_id) ON DELETE RESTRICT,
      CHECK (
        (kind = 'plan'
          AND phase = 'PLANNING'
          AND canonical_name = 'planning/plan.md')
        OR
        (kind = 'execution-summary'
          AND phase = 'RUNNING'
          AND canonical_name = 'running/execution-summary.md')
        OR
        (kind = 'review'
          AND phase = 'REVIEW'
          AND canonical_name = 'review/review.md')
      )
    ) STRICT;

    CREATE UNIQUE INDEX execution_artifacts_task_history_index
      ON execution_artifacts(task_id, ordinal);
  `,
  version: 5,
} as const;
