export const taskWorktreesMigration = {
  name: 'task-worktrees',
  sql: `
    CREATE TABLE task_worktrees (
      task_id TEXT PRIMARY KEY NOT NULL,
      repository_root_path TEXT NOT NULL CHECK (length(trim(repository_root_path)) > 0),
      worktree_path TEXT NOT NULL UNIQUE CHECK (length(trim(worktree_path)) > 0),
      path_identity TEXT NOT NULL UNIQUE CHECK (length(trim(path_identity)) > 0),
      branch_name TEXT NOT NULL CHECK (length(trim(branch_name)) > 0),
      base_ref_name TEXT NOT NULL CHECK (length(trim(base_ref_name)) > 0),
      base_commit_id TEXT NOT NULL CHECK (
        length(base_commit_id) IN (40, 64)
        AND base_commit_id NOT GLOB '*[^0-9a-f]*'
      ),
      lifecycle_state TEXT NOT NULL CHECK (
        lifecycle_state IN ('PROVISIONING', 'PRESENT', 'REMOVING', 'REMOVED')
      ),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      UNIQUE (repository_root_path, branch_name)
    ) STRICT;
  `,
  version: 3,
} as const;
