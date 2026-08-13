import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { openSqlitePersistence } from './index';
import { projectsAndTasksMigration } from './sqlite/migrations/0001-projects-and-tasks';
import { projectRootsMigration } from './sqlite/migrations/0002-project-roots';
import { taskWorktreesMigration } from './sqlite/migrations/0003-task-worktrees';
import { agentSessionsMigration } from './sqlite/migrations/0004-agent-sessions';
import { executionArtifactsMigration } from './sqlite/migrations/0005-execution-artifacts';
import { qualityGateRunsMigration } from './sqlite/migrations/0006-quality-gate-runs';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-task-review-migration-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function createV6Database(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE _agentterm_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
    ${projectsAndTasksMigration.sql}
    ${projectRootsMigration.sql}
    ${taskWorktreesMigration.sql}
    ${agentSessionsMigration.sql}
    ${executionArtifactsMigration.sql}
    ${qualityGateRunsMigration.sql}
    INSERT INTO _agentterm_migrations (version, name)
    VALUES
      (1, 'projects-and-tasks'),
      (2, 'project-roots'),
      (3, 'task-worktrees'),
      (4, 'agent-sessions'),
      (5, 'execution-artifacts'),
      (6, 'quality-gate-runs');
  `);
}

describe('SQLite Task Review migration', () => {
  it('creates the normalized immutable review history schema on an empty database', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'table'
                 AND name IN ('task_reviews', 'task_review_artifacts', 'task_review_quality_gates')
               ORDER BY name`,
            )
            .all(),
        ).toEqual([
          { name: 'task_review_artifacts' },
          { name: 'task_review_quality_gates' },
          { name: 'task_reviews' },
        ]);
        expect(
          database
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all()
            .at(-1),
        ).toEqual({ name: 'task-reviews', version: 7 });
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'index'
                 AND name IN (
                   'execution_artifacts_identity_task_index',
                   'quality_gate_runs_identity_task_index',
                   'task_reviews_task_ordinal_index',
                   'task_reviews_one_pending_per_task_index'
                 )
               ORDER BY name`,
            )
            .all(),
        ).toEqual([
          { name: 'execution_artifacts_identity_task_index' },
          { name: 'quality_gate_runs_identity_task_index' },
          { name: 'task_reviews_one_pending_per_task_index' },
          { name: 'task_reviews_task_ordinal_index' },
        ]);
        expect(
          database
            .prepare(
              `SELECT name FROM sqlite_schema
               WHERE type = 'trigger'
                 AND name IN (
                   'task_review_artifacts_limit_trigger',
                   'task_review_changed_paths_limit_trigger',
                   'task_review_quality_gates_limit_trigger'
                 )
               ORDER BY name`,
            )
            .all(),
        ).toEqual([
          { name: 'task_review_artifacts_limit_trigger' },
          { name: 'task_review_changed_paths_limit_trigger' },
          { name: 'task_review_quality_gates_limit_trigger' },
        ]);
      } finally {
        database.close();
      }
    });
  });

  it('enforces the per-Review Artifact and Quality Gate association limits', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: false });
      try {
        const insertArtifact = database.prepare(
          `INSERT INTO task_review_artifacts (
             review_id, task_id, ordinal, artifact_id, kind, phase, session_id, created_at
           ) VALUES ('review-limit', 'task-limit', ?, ?, 'plan', 'PLANNING', NULL, 1)`,
        );
        const insertGate = database.prepare(
          `INSERT INTO task_review_quality_gates (
             review_id, task_id, ordinal, quality_gate_run_id, gate_id, kind,
             observed_status, worktree_path_identity, branch_name, base_commit_id,
             head_commit_id_at_start, started_at, finished_at, association
           ) VALUES (
             'review-limit', 'task-limit', ?, ?, ?, 'TEST', 'PASSED',
             'worktree-identity', 'agentterm/task-limit',
             '1111111111111111111111111111111111111111',
             '2222222222222222222222222222222222222222', 1, 2, 'STALE'
           )`,
        );

        database.exec('BEGIN');
        for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
          insertArtifact.run(ordinal, `artifact-${ordinal}`);
          insertGate.run(ordinal, `gate-run-${ordinal}`, `gate-${ordinal}`);
        }
        database.exec('COMMIT');

        expect(() => insertArtifact.run(1_001, 'artifact-1001')).toThrow();
        expect(() => insertGate.run(1_001, 'gate-run-1001', 'gate-1001')).toThrow();
        expect(
          database.prepare('SELECT count(*) AS count FROM task_review_artifacts').get(),
        ).toEqual({ count: 1_000 });
        expect(
          database.prepare('SELECT count(*) AS count FROM task_review_quality_gates').get(),
        ).toEqual({ count: 1_000 });
      } finally {
        database.close();
      }
    });
  });

  it('upgrades v6 without changing Task, Artifact, Gate, Session, or Worktree history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        createV6Database(database);
        database.exec(`
          INSERT INTO projects (id, name) VALUES ('project-1', 'AgentTerm');
          INSERT INTO tasks (id, project_id, title, phase)
          VALUES ('task-1', 'project-1', 'Preserve review inputs', 'RUNNING');
          INSERT INTO task_worktrees (
            task_id, repository_root_path, worktree_path, path_identity,
            branch_name, base_ref_name, base_commit_id, lifecycle_state
          ) VALUES (
            'task-1', 'D:\\repo', 'D:\\worktrees\\task-1', 'worktree-identity',
            'agentterm/task-1', 'refs/heads/main',
            '1111111111111111111111111111111111111111', 'PRESENT'
          );
          INSERT INTO agent_sessions (
            id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
          ) VALUES ('session-1', 'task-1', 'codex', 1, 'EXITED', 10, 11, 2);
          INSERT INTO agent_session_events (
            session_id, sequence, kind, status, occurred_at, runtime_sequence,
            source, failure_code, fatal, stage, exit_code, exit_reason, signal
          ) VALUES
            ('session-1', 1, 'START_REQUESTED', 'STARTING', 10, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL),
            ('session-1', 2, 'PROCESS_EXITED', 'EXITED', 11, 1,
             NULL, NULL, NULL, NULL, 0, 'PROCESS_EXIT', NULL);
          INSERT INTO execution_artifacts (
            id, task_id, session_id, ordinal, kind, phase, canonical_name,
            format, schema_version, validation, content, created_at
          ) VALUES (
            'artifact-1', 'task-1', 'session-1', 1, 'execution-summary', 'RUNNING',
            'running/execution-summary.md', 'markdown', 1, 'VALID',
            '# Execution Summary\n\nPreserved.', 12
          );
          INSERT INTO quality_gate_runs (
            id, task_id, ordinal, gate_id, gate_kind, executable_path, arguments_json,
            timeout_ms, worktree_path_identity, worktree_path, worktree_branch_name,
            worktree_base_commit_id, worktree_head_commit_id, status, started_at,
            finished_at, duration_ms, exit_code, failure_category,
            output_reference, output_text, output_truncated
          ) VALUES (
            'gate-run-1', 'task-1', 1, 'test', 'TEST', 'C:\\node.exe', '[]',
            1000, 'worktree-identity', 'D:\\worktrees\\task-1', 'agentterm/task-1',
            '1111111111111111111111111111111111111111',
            '2222222222222222222222222222222222222222', 'PASSED', 13,
            14, 1, 0, NULL, 'quality-gate-output:gate-run-1', 'passed', 0
          );
        `);
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();

      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(migrated.prepare('SELECT id, phase FROM tasks').all()).toEqual([
          { id: 'task-1', phase: 'RUNNING' },
        ]);
        expect(migrated.prepare('SELECT id FROM agent_sessions').all()).toEqual([
          { id: 'session-1' },
        ]);
        expect(migrated.prepare('SELECT id FROM execution_artifacts').all()).toEqual([
          { id: 'artifact-1' },
        ]);
        expect(migrated.prepare('SELECT id FROM quality_gate_runs').all()).toEqual([
          { id: 'gate-run-1' },
        ]);
        expect(migrated.prepare('SELECT task_id FROM task_worktrees').all()).toEqual([
          { task_id: 'task-1' },
        ]);
        expect(migrated.prepare('SELECT count(*) AS count FROM task_reviews').get()).toEqual({
          count: 0,
        });
        expect(
          migrated
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all()
            .at(-1),
        ).toEqual({ name: 'task-reviews', version: 7 });
      } finally {
        migrated.close();
      }
    });
  });

  it('preserves a legacy REVIEW Task for explicit in-place structured recovery', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        createV6Database(database);
        database.exec(`
          INSERT INTO projects (id, name) VALUES ('project-1', 'AgentTerm');
          INSERT INTO tasks (id, project_id, title, phase)
          VALUES ('task-review', 'project-1', 'Legacy unstructured Review', 'REVIEW');
        `);
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();

      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(migrated.prepare("SELECT phase FROM tasks WHERE id = 'task-review'").get()).toEqual({
          phase: 'REVIEW',
        });
        expect(migrated.prepare('SELECT count(*) AS count FROM task_reviews').get()).toEqual({
          count: 0,
        });
      } finally {
        migrated.close();
      }
    });
  });
});
