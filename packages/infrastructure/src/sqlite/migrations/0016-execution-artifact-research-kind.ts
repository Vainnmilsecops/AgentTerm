/**
 * M16 — widen the execution_artifacts CHECK constraint so the research
 * artifact kind is admissible alongside the original plan / execution-summary
 * / review kinds. The canonical-name and producing-phase mappings mirror the
 * Domain ExecutionArtifactKind contract introduced in M3.
 *
 * SQLite cannot ALTER a CHECK constraint, and DROP+RENAME breaks the foreign
 * key reference held by task_review_artifacts, so we recreate both tables in
 * place within the migration runner's wrapping transaction.
 */
export const executionArtifactResearchKindMigration = {
  name: 'execution-artifact-research-kind',
  sql: `
    CREATE TABLE execution_artifacts_research_kind (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0),
      session_id TEXT CHECK (session_id IS NULL OR length(trim(session_id)) > 0),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'execution-summary', 'research', 'review')),
      phase TEXT NOT NULL CHECK (phase IN ('BACKLOG', 'PLANNING', 'RUNNING', 'REVIEW')),
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
        (kind = 'research'
          AND phase = 'BACKLOG'
          AND canonical_name = 'research/research.md')
        OR
        (kind = 'review'
          AND phase = 'REVIEW'
          AND canonical_name = 'review/review.md')
      )
    ) STRICT;

    INSERT INTO execution_artifacts_research_kind
      SELECT * FROM execution_artifacts;

    DROP TABLE execution_artifacts;

    ALTER TABLE execution_artifacts_research_kind
      RENAME TO execution_artifacts;

    CREATE UNIQUE INDEX execution_artifacts_task_history_index
      ON execution_artifacts(task_id, ordinal);

    CREATE UNIQUE INDEX execution_artifacts_identity_task_index
      ON execution_artifacts(id, task_id);

    CREATE TABLE task_review_artifacts_research_kind (
      review_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      artifact_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'execution-summary', 'research', 'review')),
      phase TEXT NOT NULL CHECK (phase IN ('BACKLOG', 'PLANNING', 'RUNNING', 'REVIEW')),
      session_id TEXT,
      created_at INTEGER NOT NULL CHECK (
        created_at BETWEEN 0 AND 9007199254740991
      ),
      PRIMARY KEY (review_id, ordinal),
      FOREIGN KEY (review_id, task_id)
        REFERENCES task_reviews(id, task_id) ON DELETE RESTRICT,
      FOREIGN KEY (artifact_id, task_id)
        REFERENCES execution_artifacts(id, task_id) ON DELETE RESTRICT,
      UNIQUE (review_id, artifact_id),
      CHECK (
        (kind = 'plan' AND phase = 'PLANNING')
        OR (kind = 'execution-summary' AND phase = 'RUNNING')
        OR (kind = 'research' AND phase = 'BACKLOG')
        OR (kind = 'review' AND phase = 'REVIEW')
      ),
      CHECK (session_id IS NULL OR (length(trim(session_id)) > 0 AND instr(session_id, char(0)) = 0))
    ) STRICT;

    INSERT INTO task_review_artifacts_research_kind
      SELECT * FROM task_review_artifacts;

    DROP TABLE task_review_artifacts;

    ALTER TABLE task_review_artifacts_research_kind
      RENAME TO task_review_artifacts;

    CREATE TRIGGER task_review_artifacts_limit_trigger
      BEFORE INSERT ON task_review_artifacts
      WHEN (
        SELECT COUNT(*) FROM task_review_artifacts WHERE review_id = NEW.review_id
      ) >= 1000
      BEGIN
        SELECT RAISE(ABORT, 'Task Review Artifact evidence exceeds 1000 rows.');
      END;
  `,
  version: 16,
} as const;