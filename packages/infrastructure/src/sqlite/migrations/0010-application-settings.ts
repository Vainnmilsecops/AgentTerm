export const applicationSettingsMigration = {
  name: 'application-settings',
  sql: `
    CREATE TABLE application_settings (
      singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
      default_agent_id TEXT NOT NULL CHECK (
        length(default_agent_id) BETWEEN 1 AND 64
        AND default_agent_id NOT GLOB '*[^a-z0-9._-]*'
        AND substr(default_agent_id, 1, 1) GLOB '[a-z0-9]'
        AND substr(default_agent_id, -1, 1) GLOB '[a-z0-9]'
      ),
      terminal_font_size INTEGER NOT NULL CHECK (terminal_font_size BETWEEN 8 AND 32)
    ) STRICT;

    INSERT INTO application_settings (
      singleton_id, schema_version, revision, default_agent_id, terminal_font_size
    ) VALUES (1, 1, 0, 'codex', 14);

    CREATE TABLE agent_executable_settings (
      settings_id INTEGER NOT NULL CHECK (settings_id = 1),
      agent_id TEXT NOT NULL CHECK (
        length(agent_id) BETWEEN 1 AND 64
        AND agent_id NOT GLOB '*[^a-z0-9._-]*'
        AND substr(agent_id, 1, 1) GLOB '[a-z0-9]'
        AND substr(agent_id, -1, 1) GLOB '[a-z0-9]'
      ),
      executable_path TEXT NOT NULL CHECK (
        length(trim(executable_path)) BETWEEN 1 AND 32768
        AND instr(executable_path, char(0)) = 0
      ),
      PRIMARY KEY (settings_id, agent_id),
      FOREIGN KEY (settings_id) REFERENCES application_settings(singleton_id)
        ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID;
  `,
  version: 10,
} as const;
