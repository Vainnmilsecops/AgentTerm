export const workflowPluginBindingsMigration = {
  name: "workflow-plugin-bindings",
  sql: `
    CREATE TABLE workflow_plugin_bindings (
      task_id TEXT PRIMARY KEY NOT NULL CHECK (
        length(task_id) BETWEEN 1 AND 128
        AND instr(task_id, char(0)) = 0
      ),
      plugin_id TEXT NOT NULL CHECK (
        length(plugin_id) BETWEEN 1 AND 64
        AND instr(plugin_id, char(0)) = 0
      ),
      source_path TEXT NOT NULL CHECK (
        length(source_path) BETWEEN 1 AND 4096
        AND instr(source_path, char(0)) = 0
      ),
      active_phase_id TEXT NOT NULL CHECK (
        length(active_phase_id) BETWEEN 1 AND 64
        AND instr(active_phase_id, char(0)) = 0
      ),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
      installed_at INTEGER NOT NULL CHECK (installed_at BETWEEN 0 AND 9007199254740991),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    ) STRICT;

    CREATE INDEX workflow_plugin_bindings_plugin_idx
      ON workflow_plugin_bindings (plugin_id);
  `,
  version: 15,
} as const;
