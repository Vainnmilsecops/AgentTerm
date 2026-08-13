export const taskDependenciesMigration = {
  name: 'task-dependencies',
  sql: `
    CREATE UNIQUE INDEX tasks_identity_project_index ON tasks(id, project_id);

    CREATE TABLE task_dependencies (
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND instr(task_id, char(0)) = 0),
      dependency_task_id TEXT NOT NULL CHECK (
        length(trim(dependency_task_id)) > 0 AND instr(dependency_task_id, char(0)) = 0
      ),
      project_id TEXT NOT NULL CHECK (
        length(trim(project_id)) > 0 AND instr(project_id, char(0)) = 0
      ),
      PRIMARY KEY (task_id, dependency_task_id),
      CHECK (task_id <> dependency_task_id),
      FOREIGN KEY (task_id, project_id)
        REFERENCES tasks(id, project_id) ON DELETE RESTRICT,
      FOREIGN KEY (dependency_task_id, project_id)
        REFERENCES tasks(id, project_id) ON DELETE RESTRICT
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX task_dependencies_project_index
      ON task_dependencies(project_id, task_id, dependency_task_id);

    CREATE TRIGGER task_dependencies_prevent_cycle
    BEFORE INSERT ON task_dependencies
    BEGIN
      SELECT CASE WHEN EXISTS (
        WITH RECURSIVE reachable(task_id) AS (
          SELECT dependency_task_id
          FROM task_dependencies
          WHERE task_id = NEW.dependency_task_id
          UNION
          SELECT dependency.dependency_task_id
          FROM task_dependencies AS dependency
          INNER JOIN reachable ON dependency.task_id = reachable.task_id
        )
        SELECT 1 FROM reachable WHERE task_id = NEW.task_id
      ) THEN RAISE(ABORT, 'task_dependency_cycle') END;
    END;
  `,
  version: 8,
} as const;
