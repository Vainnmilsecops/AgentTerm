export const pullRequestsMigration = {
  name: 'pull-requests',
  sql: `
    CREATE TABLE task_pull_requests (
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
      PRIMARY KEY (
        task_id, provider, repository_owner, repository_name, base_branch, head_branch
      ),
      UNIQUE (provider, repository_owner, repository_name, pull_request_number),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX task_pull_requests_task_updated_index
      ON task_pull_requests(task_id, updated_at, pull_request_number);
  `,
  version: 9,
} as const;
