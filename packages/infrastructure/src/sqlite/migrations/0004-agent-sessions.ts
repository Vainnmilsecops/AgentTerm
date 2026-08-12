export const agentSessionsMigration = {
  name: 'agent-sessions',
  sql: `
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0),
      agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0),
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      status TEXT NOT NULL CHECK (
        status IN ('STARTING', 'WORKING', 'IDLE', 'WAITING_INPUT', 'EXITED', 'FAILED')
      ),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      ended_at INTEGER CHECK (ended_at >= created_at),
      history_sequence INTEGER NOT NULL CHECK (history_sequence > 0),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
      CHECK (
        (status IN ('EXITED', 'FAILED') AND ended_at IS NOT NULL)
        OR
        (status IN ('STARTING', 'WORKING', 'IDLE', 'WAITING_INPUT') AND ended_at IS NULL)
      )
    ) STRICT;

    CREATE UNIQUE INDEX agent_sessions_task_ordinal_index
      ON agent_sessions(task_id, ordinal);

    CREATE TABLE agent_session_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      kind TEXT NOT NULL CHECK (
        kind IN (
          'START_REQUESTED',
          'STATUS_REPORTED',
          'STOP_REQUESTED',
          'RUNTIME_FAILED',
          'PROCESS_EXITED'
        )
      ),
      status TEXT NOT NULL CHECK (
        status IN ('STARTING', 'WORKING', 'IDLE', 'WAITING_INPUT', 'EXITED', 'FAILED')
      ),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      runtime_sequence INTEGER CHECK (runtime_sequence > 0),
      source TEXT CHECK (source IN ('APPLICATION', 'RUNTIME')),
      failure_code TEXT CHECK (length(trim(failure_code)) > 0),
      fatal INTEGER CHECK (fatal IN (0, 1)),
      stage TEXT CHECK (
        stage IN ('CLEANUP', 'RESIZE', 'RUNTIME', 'START', 'TERMINATE', 'WRITE')
      ),
      exit_code INTEGER,
      exit_reason TEXT CHECK (exit_reason IN ('PROCESS_EXIT', 'STOPPED')),
      signal INTEGER,
      PRIMARY KEY (session_id, sequence),
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE RESTRICT,
      CHECK (
        (kind = 'START_REQUESTED'
          AND sequence = 1
          AND status = 'STARTING'
          AND runtime_sequence IS NULL
          AND source IS NULL
          AND failure_code IS NULL
          AND fatal IS NULL
          AND stage IS NULL
          AND exit_code IS NULL
          AND exit_reason IS NULL
          AND signal IS NULL)
        OR
        (kind = 'STATUS_REPORTED'
          AND status IN ('WORKING', 'IDLE', 'WAITING_INPUT')
          AND source IS NOT NULL
          AND failure_code IS NULL
          AND fatal IS NULL
          AND stage IS NULL
          AND exit_code IS NULL
          AND exit_reason IS NULL
          AND signal IS NULL)
        OR
        (kind = 'STOP_REQUESTED'
          AND runtime_sequence IS NULL
          AND source IS NULL
          AND failure_code IS NULL
          AND fatal IS NULL
          AND stage IS NULL
          AND exit_code IS NULL
          AND exit_reason IS NULL
          AND signal IS NULL)
        OR
        (kind = 'RUNTIME_FAILED'
          AND source IS NULL
          AND failure_code IS NOT NULL
          AND fatal IS NOT NULL
          AND stage IS NOT NULL
          AND ((fatal = 1 AND status = 'FAILED') OR fatal = 0)
          AND exit_code IS NULL
          AND exit_reason IS NULL
          AND signal IS NULL)
        OR
        (kind = 'PROCESS_EXITED'
          AND status IN ('EXITED', 'FAILED')
          AND runtime_sequence IS NOT NULL
          AND source IS NULL
          AND failure_code IS NULL
          AND fatal IS NULL
          AND stage IS NULL
          AND exit_code IS NOT NULL
          AND exit_reason IS NOT NULL)
      )
    ) STRICT;

    CREATE UNIQUE INDEX agent_session_events_runtime_sequence_index
      ON agent_session_events(session_id, runtime_sequence)
      WHERE runtime_sequence IS NOT NULL;
  `,
  version: 4,
} as const;
