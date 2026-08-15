export const agentSessionHostOwnershipMigration = {
  name: 'agent-session-host-ownership',
  sql: `
    ALTER TABLE agent_sessions ADD COLUMN host_ownership TEXT CHECK (
      host_ownership IS NULL
      OR (
        length(host_ownership) BETWEEN 1 AND 16384
        AND instr(host_ownership, char(0)) = 0
        AND json_valid(host_ownership) = 1
      )
    );

    ALTER TABLE agent_sessions ADD COLUMN provider_session_id TEXT CHECK (
      provider_session_id IS NULL
      OR (length(provider_session_id) BETWEEN 4 AND 128 AND instr(provider_session_id, char(0)) = 0)
    );
  `,
  version: 14,
} as const;
