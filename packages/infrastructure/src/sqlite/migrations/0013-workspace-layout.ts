export const workspaceLayoutMigration = {
  name: 'workspace-layout',
  sql: `
    CREATE TABLE workspace_layout (
      singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
      updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
      layout_json TEXT NOT NULL CHECK (
        length(layout_json) BETWEEN 1 AND 32768
        AND instr(layout_json, char(0)) = 0
      )
    ) STRICT;
  `,
  version: 13,
} as const;
