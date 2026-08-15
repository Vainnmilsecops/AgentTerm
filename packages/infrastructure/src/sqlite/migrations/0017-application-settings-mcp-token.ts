/**
 * M17 — store the optional MCP server token alongside Application Settings.
 * The token is opt-in: NULL keeps the MCP server disabled (default off).
 */
export const applicationSettingsMcpTokenMigration = {
  name: 'application-settings-mcp-token',
  sql: `
    ALTER TABLE application_settings ADD COLUMN mcp_server_token TEXT
      CHECK (mcp_server_token IS NULL
        OR (length(trim(mcp_server_token)) BETWEEN 16 AND 256
            AND instr(mcp_server_token, char(0)) = 0
            AND mcp_server_token NOT GLOB '*[^!-~]*'));
  `,
  version: 17,
} as const;