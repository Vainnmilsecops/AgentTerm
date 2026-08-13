export const taskReviewsMigration = {
  name: 'task-reviews',
  sql: `
    CREATE UNIQUE INDEX execution_artifacts_identity_task_index
      ON execution_artifacts(id, task_id);

    CREATE UNIQUE INDEX quality_gate_runs_identity_task_index
      ON quality_gate_runs(id, task_id);

    CREATE TABLE task_reviews (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0 AND instr(id, char(0)) = 0),
      task_id TEXT NOT NULL CHECK (
        length(trim(task_id)) > 0 AND instr(task_id, char(0)) = 0
      ),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      status TEXT NOT NULL CHECK (
        status IN ('PENDING', 'APPROVED', 'CHANGES_REQUESTED')
      ),
      requested_at INTEGER NOT NULL CHECK (
        requested_at BETWEEN 0 AND 9007199254740991
      ),
      decided_at INTEGER CHECK (
        decided_at BETWEEN requested_at AND 9007199254740991
      ),
      decision_note TEXT CHECK (
        decision_note IS NULL
        OR (
          length(trim(decision_note)) > 0
          AND length(decision_note) <= 65536
          AND instr(decision_note, char(0)) = 0
        )
      ),
      code_schema_version INTEGER NOT NULL CHECK (code_schema_version = 1),
      worktree_path_identity TEXT NOT NULL CHECK (
        length(trim(worktree_path_identity)) > 0
        AND instr(worktree_path_identity, char(0)) = 0
      ),
      branch_name TEXT NOT NULL CHECK (
        length(trim(branch_name)) > 0 AND instr(branch_name, char(0)) = 0
      ),
      base_commit_id TEXT NOT NULL CHECK (
        length(base_commit_id) IN (40, 64)
        AND base_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      head_commit_id TEXT NOT NULL CHECK (
        length(head_commit_id) IN (40, 64)
        AND head_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      code_state_fingerprint TEXT NOT NULL CHECK (
        length(code_state_fingerprint) = 64
        AND code_state_fingerprint NOT GLOB '*[^0-9a-f]*'
      ),
      changes_total INTEGER NOT NULL CHECK (
        changes_total BETWEEN 0 AND 9007199254740991
      ),
      changes_truncated INTEGER NOT NULL CHECK (changes_truncated IN (0, 1)),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      UNIQUE (id, task_id),
      CHECK (
        (status = 'PENDING' AND decided_at IS NULL AND decision_note IS NULL)
        OR (status <> 'PENDING' AND decided_at IS NOT NULL)
      )
    ) STRICT;

    CREATE UNIQUE INDEX task_reviews_task_ordinal_index
      ON task_reviews(task_id, ordinal);

    CREATE UNIQUE INDEX task_reviews_one_pending_per_task_index
      ON task_reviews(task_id) WHERE status = 'PENDING';

    CREATE TABLE task_review_changed_paths (
      review_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('COMMITTED', 'CONFLICTED', 'STAGED', 'UNSTAGED', 'UNTRACKED')
      ),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      path TEXT NOT NULL CHECK (
        length(trim(path)) > 0 AND length(path) <= 32768 AND instr(path, char(0)) = 0
      ),
      PRIMARY KEY (review_id, category, ordinal),
      FOREIGN KEY (review_id, task_id)
        REFERENCES task_reviews(id, task_id) ON DELETE RESTRICT,
      UNIQUE (review_id, category, path)
    ) STRICT;

    CREATE TRIGGER task_review_changed_paths_limit_trigger
      BEFORE INSERT ON task_review_changed_paths
      WHEN (
        SELECT COUNT(*) FROM task_review_changed_paths WHERE review_id = NEW.review_id
      ) >= 200
    BEGIN
      SELECT RAISE(ABORT, 'Task Review changed-path evidence exceeds 200 rows.');
    END;

    CREATE TABLE task_review_artifacts (
      review_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      artifact_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('plan', 'execution-summary', 'review')),
      phase TEXT NOT NULL CHECK (phase IN ('PLANNING', 'RUNNING', 'REVIEW')),
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
        OR (kind = 'review' AND phase = 'REVIEW')
      ),
      CHECK (session_id IS NULL OR (length(trim(session_id)) > 0 AND instr(session_id, char(0)) = 0))
    ) STRICT;

    CREATE TRIGGER task_review_artifacts_limit_trigger
      BEFORE INSERT ON task_review_artifacts
      WHEN (
        SELECT COUNT(*) FROM task_review_artifacts WHERE review_id = NEW.review_id
      ) >= 1000
    BEGIN
      SELECT RAISE(ABORT, 'Task Review Artifact evidence exceeds 1000 rows.');
    END;

    CREATE TABLE task_review_quality_gates (
      review_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      quality_gate_run_id TEXT NOT NULL,
      gate_id TEXT NOT NULL CHECK (length(trim(gate_id)) > 0 AND instr(gate_id, char(0)) = 0),
      kind TEXT NOT NULL CHECK (kind IN ('LINT', 'TYPECHECK', 'TEST', 'BUILD')),
      observed_status TEXT NOT NULL CHECK (
        observed_status IN (
          'RUNNING',
          'PASSED',
          'FAILED',
          'TIMED_OUT',
          'LAUNCH_FAILED',
          'INFRASTRUCTURE_FAILED'
        )
      ),
      worktree_path_identity TEXT NOT NULL CHECK (
        length(trim(worktree_path_identity)) > 0
        AND instr(worktree_path_identity, char(0)) = 0
      ),
      branch_name TEXT NOT NULL CHECK (
        length(trim(branch_name)) > 0 AND instr(branch_name, char(0)) = 0
      ),
      base_commit_id TEXT NOT NULL CHECK (
        length(base_commit_id) IN (40, 64)
        AND base_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      head_commit_id_at_start TEXT NOT NULL CHECK (
        length(head_commit_id_at_start) IN (40, 64)
        AND head_commit_id_at_start NOT GLOB '*[^0-9a-f]*'
      ),
      started_at INTEGER NOT NULL CHECK (started_at BETWEEN 0 AND 9007199254740991),
      finished_at INTEGER CHECK (finished_at BETWEEN started_at AND 9007199254740991),
      association TEXT NOT NULL CHECK (association IN ('STALE', 'HEAD_MATCH_ONLY')),
      PRIMARY KEY (review_id, ordinal),
      FOREIGN KEY (review_id, task_id)
        REFERENCES task_reviews(id, task_id) ON DELETE RESTRICT,
      FOREIGN KEY (quality_gate_run_id, task_id)
        REFERENCES quality_gate_runs(id, task_id) ON DELETE RESTRICT,
      UNIQUE (review_id, quality_gate_run_id),
      CHECK (
        (observed_status = 'RUNNING' AND finished_at IS NULL)
        OR (observed_status <> 'RUNNING' AND finished_at IS NOT NULL)
      )
    ) STRICT;

    CREATE TRIGGER task_review_quality_gates_limit_trigger
      BEFORE INSERT ON task_review_quality_gates
      WHEN (
        SELECT COUNT(*) FROM task_review_quality_gates WHERE review_id = NEW.review_id
      ) >= 1000
    BEGIN
      SELECT RAISE(ABORT, 'Task Review Quality Gate evidence exceeds 1000 rows.');
    END;
  `,
  version: 7,
} as const;
