export const qualityGateRunsMigration = {
  name: 'quality-gate-runs',
  sql: `
    CREATE TABLE quality_gate_runs (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0 AND instr(id, char(0)) = 0),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND instr(task_id, char(0)) = 0),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      gate_id TEXT NOT NULL CHECK (
        length(trim(gate_id)) > 0 AND instr(gate_id, char(0)) = 0
      ),
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('LINT', 'TYPECHECK', 'TEST', 'BUILD')),
      executable_path TEXT NOT NULL CHECK (
        length(trim(executable_path)) > 0 AND instr(executable_path, char(0)) = 0
      ),
      arguments_json TEXT NOT NULL CHECK (
        json_valid(arguments_json) AND json_type(arguments_json) = 'array'
      ),
      timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
      worktree_path_identity TEXT NOT NULL CHECK (
        length(trim(worktree_path_identity)) > 0 AND instr(worktree_path_identity, char(0)) = 0
      ),
      worktree_path TEXT NOT NULL CHECK (
        length(trim(worktree_path)) > 0 AND instr(worktree_path, char(0)) = 0
      ),
      worktree_branch_name TEXT NOT NULL CHECK (
        length(trim(worktree_branch_name)) > 0 AND instr(worktree_branch_name, char(0)) = 0
      ),
      worktree_base_commit_id TEXT NOT NULL CHECK (
        length(worktree_base_commit_id) IN (40, 64)
        AND worktree_base_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      worktree_head_commit_id TEXT NOT NULL CHECK (
        length(worktree_head_commit_id) IN (40, 64)
        AND worktree_head_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      status TEXT NOT NULL CHECK (
        status IN (
          'RUNNING',
          'PASSED',
          'FAILED',
          'TIMED_OUT',
          'LAUNCH_FAILED',
          'INFRASTRUCTURE_FAILED'
        )
      ),
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      finished_at INTEGER,
      duration_ms INTEGER,
      exit_code INTEGER,
      failure_category TEXT CHECK (
        failure_category IN ('COMMAND', 'INFRASTRUCTURE', 'LAUNCH', 'TIMEOUT')
      ),
      output_reference TEXT UNIQUE CHECK (
        length(trim(output_reference)) > 0 AND instr(output_reference, char(0)) = 0
      ),
      output_text TEXT CHECK (length(CAST(output_text AS BLOB)) <= 262144),
      output_truncated INTEGER CHECK (output_truncated IN (0, 1)),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      CHECK (timeout_ms <= 86400000),
      CHECK (started_at <= 9007199254740991),
      CHECK (finished_at IS NULL OR finished_at <= 9007199254740991),
      CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
      CHECK (
        (status = 'RUNNING'
          AND finished_at IS NULL
          AND duration_ms IS NULL
          AND exit_code IS NULL
          AND failure_category IS NULL
          AND output_reference IS NULL
          AND output_text IS NULL
          AND output_truncated IS NULL)
        OR
        (status <> 'RUNNING'
          AND finished_at IS NOT NULL
          AND finished_at >= started_at
          AND duration_ms = finished_at - started_at
          AND output_reference IS NOT NULL
          AND output_text IS NOT NULL
          AND output_truncated IS NOT NULL)
      ),
      CHECK (
        (status = 'PASSED' AND exit_code = 0 AND failure_category IS NULL)
        OR
        (status = 'FAILED' AND exit_code IS NOT NULL AND exit_code <> 0
          AND failure_category = 'COMMAND')
        OR
        (status = 'TIMED_OUT' AND exit_code IS NULL AND failure_category = 'TIMEOUT')
        OR
        (status = 'LAUNCH_FAILED' AND exit_code IS NULL AND failure_category = 'LAUNCH')
        OR
        (status = 'INFRASTRUCTURE_FAILED'
          AND exit_code IS NULL AND failure_category = 'INFRASTRUCTURE')
        OR status = 'RUNNING'
      )
    ) STRICT;

    CREATE UNIQUE INDEX quality_gate_runs_task_ordinal_index
      ON quality_gate_runs(task_id, ordinal);
  `,
  version: 5,
} as const;
