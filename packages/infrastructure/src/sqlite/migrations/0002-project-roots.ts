export const projectRootsMigration = {
  name: 'project-roots',
  sql: `
    CREATE TABLE project_roots (
      project_id TEXT PRIMARY KEY NOT NULL,
      canonical_path TEXT NOT NULL UNIQUE CHECK (length(trim(canonical_path)) > 0),
      path_identity TEXT NOT NULL UNIQUE CHECK (length(trim(path_identity)) > 0),
      last_opened_order INTEGER NOT NULL UNIQUE CHECK (last_opened_order > 0),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX project_roots_recent_index
      ON project_roots(last_opened_order DESC, project_id);
  `,
  version: 2,
} as const;
