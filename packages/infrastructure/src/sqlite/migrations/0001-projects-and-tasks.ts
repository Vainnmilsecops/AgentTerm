export const projectsAndTasksMigration = {
  name: 'projects-and-tasks',
  sql: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
      name TEXT NOT NULL CHECK (length(trim(name)) > 0)
    ) STRICT;

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
      project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
      title TEXT NOT NULL CHECK (length(trim(title)) > 0),
      phase TEXT NOT NULL CHECK (
        phase IN ('BACKLOG', 'PLANNING', 'RUNNING', 'REVIEW', 'DONE')
      ),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX tasks_project_id_index ON tasks(project_id);
  `,
  version: 1,
} as const;
