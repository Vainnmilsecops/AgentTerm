/**
 * M6 — minimal research orchestrator: persist an append-only audit trail of
 * Task phase transitions so reviewers can distinguish manual moves from
 * automated `RESEARCH_AUTO_ADVANCE` ones. The table is intentionally narrow
 * (no UPDATE/DELETE) and indexed by `(task_id, created_at DESC)` for the
 * workspace overview projection.
 */
export const taskTransitionAuditMigration = {
  name: 'task-transition-audit',
  sql: `
    CREATE TABLE task_transition_audit (
      id TEXT PRIMARY KEY NOT NULL CHECK (
        length(id) BETWEEN 1 AND 256
        AND instr(id, char(0)) = 0
      ),
      task_id TEXT NOT NULL CHECK (
        length(task_id) BETWEEN 1 AND 128
        AND instr(task_id, char(0)) = 0
      ),
      from_phase TEXT NOT NULL CHECK (
        length(from_phase) BETWEEN 1 AND 32
        AND instr(from_phase, char(0)) = 0
      ),
      to_phase TEXT NOT NULL CHECK (
        length(to_phase) BETWEEN 1 AND 32
        AND instr(to_phase, char(0)) = 0
      ),
      trigger_kind TEXT NOT NULL CHECK (
        trigger_kind IN ('manual', 'research-auto-advance')
      ),
      artifact_id TEXT
        CHECK (artifact_id IS NULL
          OR (length(artifact_id) BETWEEN 1 AND 128
              AND instr(artifact_id, char(0)) = 0)),
      created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      CHECK (from_phase <> to_phase),
      CHECK (trigger_kind <> 'research-auto-advance' OR artifact_id IS NOT NULL),
      CHECK (trigger_kind <> 'research-auto-advance' OR (from_phase = 'BACKLOG' AND to_phase = 'PLANNING'))
    ) STRICT;

    CREATE INDEX task_transition_audit_task_idx
      ON task_transition_audit (task_id, created_at DESC);
  `,
  version: 19,
} as const;
