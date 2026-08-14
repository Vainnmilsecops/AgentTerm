export const pullRequestSyncMigration = {
  name: 'pull-request-sync',
  sql: `
    ALTER TABLE task_pull_requests ADD COLUMN review_state TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK (review_state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'NONE', 'UNKNOWN'));
    ALTER TABLE task_pull_requests ADD COLUMN check_state TEXT NOT NULL DEFAULT 'UNKNOWN'
      CHECK (check_state IN ('FAILURE', 'NONE', 'PENDING', 'SUCCESS', 'UNKNOWN'));
    ALTER TABLE task_pull_requests ADD COLUMN check_total_count INTEGER NOT NULL DEFAULT 0
      CHECK (check_total_count BETWEEN 0 AND 2000);
    ALTER TABLE task_pull_requests ADD COLUMN check_success_count INTEGER NOT NULL DEFAULT 0
      CHECK (check_success_count BETWEEN 0 AND check_total_count);
    ALTER TABLE task_pull_requests ADD COLUMN check_failure_count INTEGER NOT NULL DEFAULT 0
      CHECK (check_failure_count BETWEEN 0 AND check_total_count);
    ALTER TABLE task_pull_requests ADD COLUMN check_pending_count INTEGER NOT NULL DEFAULT 0
      CHECK (check_pending_count BETWEEN 0 AND check_total_count);
    ALTER TABLE task_pull_requests ADD COLUMN last_synced_at INTEGER
      CHECK (last_synced_at IS NULL OR last_synced_at BETWEEN 0 AND 8640000000000000);

    CREATE TABLE task_pull_request_sync_history (
      task_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider = 'github'),
      repository_owner TEXT NOT NULL CHECK (
        length(repository_owner) BETWEEN 1 AND 255
        AND repository_owner NOT GLOB '*[^A-Za-z0-9_.-]*'
      ),
      repository_name TEXT NOT NULL CHECK (
        length(repository_name) BETWEEN 1 AND 255
        AND repository_name NOT GLOB '*[^A-Za-z0-9_.-]*'
      ),
      base_branch TEXT NOT NULL CHECK (
        length(trim(base_branch)) BETWEEN 1 AND 1024 AND instr(base_branch, char(0)) = 0
      ),
      head_branch TEXT NOT NULL CHECK (
        length(trim(head_branch)) BETWEEN 1 AND 1024 AND instr(head_branch, char(0)) = 0
      ),
      ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 9007199254740991),
      pull_request_number INTEGER NOT NULL CHECK (
        pull_request_number BETWEEN 1 AND 9007199254740991
      ),
      url TEXT NOT NULL CHECK (
        url = 'https://github.com/' || repository_owner || '/' || repository_name ||
          '/pull/' || CAST(pull_request_number AS TEXT)
      ),
      title TEXT NOT NULL CHECK (
        length(trim(title)) BETWEEN 1 AND 1024 AND instr(title, char(0)) = 0
      ),
      head_commit_id TEXT NOT NULL CHECK (
        length(head_commit_id) IN (40, 64)
        AND head_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'MERGED')),
      draft INTEGER NOT NULL CHECK (draft IN (0, 1)),
      created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
      updated_at INTEGER NOT NULL CHECK (
        updated_at BETWEEN created_at AND 9007199254740991
      ),
      review_state TEXT NOT NULL CHECK (
        review_state IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'NONE', 'UNKNOWN')
      ),
      check_state TEXT NOT NULL CHECK (
        check_state IN ('FAILURE', 'NONE', 'PENDING', 'SUCCESS', 'UNKNOWN')
      ),
      check_total_count INTEGER NOT NULL CHECK (check_total_count BETWEEN 0 AND 2000),
      check_success_count INTEGER NOT NULL CHECK (
        check_success_count BETWEEN 0 AND check_total_count
      ),
      check_failure_count INTEGER NOT NULL CHECK (
        check_failure_count BETWEEN 0 AND check_total_count
      ),
      check_pending_count INTEGER NOT NULL CHECK (
        check_pending_count BETWEEN 0 AND check_total_count
      ),
      last_synced_at INTEGER CHECK (
        last_synced_at IS NULL OR last_synced_at BETWEEN 0 AND 8640000000000000
      ),
      PRIMARY KEY (
        task_id, provider, repository_owner, repository_name, pull_request_number, ordinal
      ),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    INSERT INTO task_pull_request_sync_history (
      task_id, provider, repository_owner, repository_name, base_branch, head_branch, ordinal,
      pull_request_number, url, title, head_commit_id, status, draft, created_at, updated_at,
      review_state, check_state, check_total_count, check_success_count, check_failure_count,
      check_pending_count, last_synced_at
    )
    SELECT
      task_id, provider, repository_owner, repository_name, base_branch, head_branch, 1,
      pull_request_number, url, title, head_commit_id, status, draft, created_at, updated_at,
      review_state, check_state, check_total_count, check_success_count, check_failure_count,
      check_pending_count, last_synced_at
    FROM task_pull_requests;

    CREATE INDEX task_pull_request_sync_history_task_index
      ON task_pull_request_sync_history(task_id, ordinal);
  `,
  version: 11,
} as const;
