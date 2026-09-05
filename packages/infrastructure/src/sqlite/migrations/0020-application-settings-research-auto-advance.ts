/**
 * M6 — minimal research orchestrator: add the `research_auto_advance` boolean
 * to the Application Settings singleton, defaulting to 0 (off). The
 * schema_version is bumped from 2 to 3; existing rows are rewritten in place.
 */
export const applicationSettingsResearchAutoAdvanceMigration = {
  name: 'application-settings-research-auto-advance',
  sql: `
    CREATE TABLE application_settings_new (
      singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
      schema_version INTEGER NOT NULL CHECK (schema_version BETWEEN 1 AND 2147483647),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
      default_agent_id TEXT NOT NULL CHECK (
        length(default_agent_id) BETWEEN 1 AND 64
        AND default_agent_id NOT GLOB '*[^a-z0-9._-]*'
        AND substr(default_agent_id, 1, 1) GLOB '[a-z0-9]'
        AND substr(default_agent_id, -1, 1) GLOB '[a-z0-9]'
      ),
      terminal_font_size INTEGER NOT NULL CHECK (terminal_font_size BETWEEN 8 AND 32),
      mcp_server_token TEXT
        CHECK (mcp_server_token IS NULL
          OR (length(trim(mcp_server_token)) BETWEEN 16 AND 256
              AND instr(mcp_server_token, char(0)) = 0
              AND mcp_server_token NOT GLOB '*[^!-~]*')),
      allow_clipboard_read_write INTEGER NOT NULL DEFAULT 0
        CHECK (allow_clipboard_read_write IN (0, 1)),
      research_auto_advance INTEGER NOT NULL DEFAULT 0
        CHECK (research_auto_advance IN (0, 1))
    ) STRICT;

    INSERT INTO application_settings_new (
      singleton_id, schema_version, revision, default_agent_id, terminal_font_size, mcp_server_token, allow_clipboard_read_write, research_auto_advance
    )
    SELECT singleton_id, 3, revision, default_agent_id, terminal_font_size, mcp_server_token, allow_clipboard_read_write, 0
    FROM application_settings;

    DROP TABLE application_settings;
    ALTER TABLE application_settings_new RENAME TO application_settings;
  `,
  version: 20,
} as const;
