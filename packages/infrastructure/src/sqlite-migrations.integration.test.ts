import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { openSqlitePersistence, SqlitePersistenceError } from './index';
import { projectsAndTasksMigration } from './sqlite/migrations/0001-projects-and-tasks';
import { projectRootsMigration } from './sqlite/migrations/0002-project-roots';
import { taskWorktreesMigration } from './sqlite/migrations/0003-task-worktrees';
import { agentSessionsMigration } from './sqlite/migrations/0004-agent-sessions';
import { executionArtifactsMigration } from './sqlite/migrations/0005-execution-artifacts';
import { qualityGateRunsMigration } from './sqlite/migrations/0006-quality-gate-runs';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-sqlite-migration-'));
  const databasePath = join(directory, 'agentterm.db');

  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function createSchemaThroughV4(database: DatabaseSync): void {
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
    INSERT INTO _agentterm_migrations (version, name)
    VALUES
      (1, 'projects-and-tasks'),
      (2, 'project-roots'),
      (3, 'task-worktrees'),
      (4, 'agent-sessions');
    INSERT INTO projects (id, name) VALUES ('project-1', 'AgentTerm');
    INSERT INTO tasks (id, project_id, title, phase)
    VALUES ('task-1', 'project-1', 'Preserve migration history', 'RUNNING');
  `);
}

function createLegacyQualityGateV5Database(database: DatabaseSync): void {
  createSchemaThroughV4(database);
  database.exec(qualityGateRunsMigration.sql);
  database
    .prepare(
      `INSERT INTO _agentterm_migrations (version, name, applied_at)
       VALUES (5, 'quality-gate-runs', ?)`,
    )
    .run('2026-08-01 10:00:00');
  database
    .prepare(
      `INSERT INTO quality_gate_runs (
         id, task_id, ordinal, gate_id, gate_kind, executable_path, arguments_json,
         timeout_ms, worktree_path_identity, worktree_path, worktree_branch_name,
         worktree_base_commit_id, worktree_head_commit_id, status, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
    )
    .run(
      'legacy-run',
      'task-1',
      1,
      'test',
      'TEST',
      'C:\\Program Files\\nodejs\\node.exe',
      '["test"]',
      120_000,
      'win32:d:\\worktrees\\task-1',
      'D:\\worktrees\\task-1',
      'agentterm/task/task-1',
      'a'.repeat(40),
      'b'.repeat(40),
      1_800_000_000_000,
    );
}

describe('SQLite migrations', () => {
  it('applies the current Project, Task, Worktree, Session, Artifact, Quality Gate, and Review schema once', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();
      openSqlitePersistence(databasePath).close();

      const database = new DatabaseSync(databasePath, { readOnly: true });

      try {
        const tables = database
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
          )
          .all()
          .map(({ name }) => name);
        const migrations = database
          .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
          .all();
        const indexes = database
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'index'
               AND name IN (
                 'agent_session_events_runtime_sequence_index',
                 'agent_sessions_task_ordinal_index',
                 'agent_sessions_identity_task_index',
                 'execution_artifacts_identity_task_index',
                 'execution_artifacts_task_history_index',
                 'quality_gate_runs_identity_task_index',
                 'quality_gate_runs_task_ordinal_index',
                 'task_reviews_one_pending_per_task_index',
                 'task_reviews_task_ordinal_index',
                 'task_dependencies_project_index',
                 'tasks_identity_project_index',
                 'tasks_project_id_index',
                 'project_roots_recent_index'
               )
             ORDER BY name`,
          )
          .all();

        expect(tables).toEqual([
          '_agentterm_migrations',
          'agent_session_events',
          'agent_sessions',
          'execution_artifacts',
          'project_roots',
          'projects',
          'quality_gate_runs',
          'task_dependencies',
          'task_review_artifacts',
          'task_review_changed_paths',
          'task_review_quality_gates',
          'task_reviews',
          'task_worktrees',
          'tasks',
        ]);
        expect(migrations).toEqual([
          { name: 'projects-and-tasks', version: 1 },
          { name: 'project-roots', version: 2 },
          { name: 'task-worktrees', version: 3 },
          { name: 'agent-sessions', version: 4 },
          { name: 'execution-artifacts', version: 5 },
          { name: 'quality-gate-runs', version: 6 },
          { name: 'task-reviews', version: 7 },
          { name: 'task-dependencies', version: 8 },
        ]);
        expect(indexes).toEqual([
          { name: 'agent_session_events_runtime_sequence_index' },
          { name: 'agent_sessions_identity_task_index' },
          { name: 'agent_sessions_task_ordinal_index' },
          { name: 'execution_artifacts_identity_task_index' },
          { name: 'execution_artifacts_task_history_index' },
          { name: 'project_roots_recent_index' },
          { name: 'quality_gate_runs_identity_task_index' },
          { name: 'quality_gate_runs_task_ordinal_index' },
          { name: 'task_dependencies_project_index' },
          { name: 'task_reviews_one_pending_per_task_index' },
          { name: 'task_reviews_task_ordinal_index' },
          { name: 'tasks_identity_project_index' },
          { name: 'tasks_project_id_index' },
        ]);
      } finally {
        database.close();
      }
    });
  });

  it('enforces TaskPhase and Project relationship constraints', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });

      try {
        database
          .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
          .run('project-1', 'AgentTerm');
        const insertTask = database.prepare(
          'INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)',
        );

        expect(() =>
          insertTask.run('invalid-phase', 'project-1', 'Invalid phase', 'EXITED'),
        ).toThrow();
        expect(() =>
          insertTask.run('missing-project', 'missing', 'Missing project', 'BACKLOG'),
        ).toThrow();
        expect(database.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({
          count: 0,
        });
      } finally {
        database.close();
      }
    });
  });

  it('rejects an unknown migration ledger instead of guessing compatibility', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();
      const database = new DatabaseSync(databasePath);

      try {
        database
          .prepare('INSERT INTO _agentterm_migrations (version, name) VALUES (?, ?)')
          .run(999, 'future-migration');
      } finally {
        database.close();
      }

      expect(() => openSqlitePersistence(databasePath)).toThrow(SqlitePersistenceError);
    });
  });

  it('preserves v1 Project and Task data without inventing a local repository root', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });

      try {
        database.exec(`
          CREATE TABLE _agentterm_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT;
          ${projectsAndTasksMigration.sql}
          INSERT INTO _agentterm_migrations (version, name)
          VALUES (1, 'projects-and-tasks');
        `);
        database
          .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
          .run('legacy-project', 'Legacy Project');
        database
          .prepare('INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)')
          .run('legacy-task', 'legacy-project', 'Legacy Task', 'PLANNING');
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();
      const migrated = new DatabaseSync(databasePath, { readOnly: true });

      try {
        expect(migrated.prepare('SELECT id, name FROM projects').all()).toEqual([
          { id: 'legacy-project', name: 'Legacy Project' },
        ]);
        expect(migrated.prepare('SELECT id, project_id, title, phase FROM tasks').all()).toEqual([
          {
            id: 'legacy-task',
            phase: 'PLANNING',
            project_id: 'legacy-project',
            title: 'Legacy Task',
          },
        ]);
        expect(migrated.prepare('SELECT count(*) AS count FROM project_roots').get()).toEqual({
          count: 0,
        });
      } finally {
        migrated.close();
      }
    });
  });

  it('upgrades a v2 database without changing existing Project, Task, or root data', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });

      try {
        database.exec(`
          CREATE TABLE _agentterm_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT;
          ${projectsAndTasksMigration.sql}
          ${projectRootsMigration.sql}
          INSERT INTO _agentterm_migrations (version, name)
          VALUES (1, 'projects-and-tasks'), (2, 'project-roots');
        `);
        database
          .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
          .run('legacy-project', 'Legacy Project');
        database
          .prepare('INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)')
          .run('legacy-task', 'legacy-project', 'Legacy Task', 'RUNNING');
        database
          .prepare(
            `INSERT INTO project_roots (
               project_id,
               canonical_path,
               path_identity,
               last_opened_order
             ) VALUES (?, ?, ?, ?)`,
          )
          .run('legacy-project', 'C:\\repos\\legacy', 'legacy-root-identity', 7);
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();
      const migrated = new DatabaseSync(databasePath, { readOnly: true });

      try {
        expect(migrated.prepare('SELECT id, name FROM projects').all()).toEqual([
          { id: 'legacy-project', name: 'Legacy Project' },
        ]);
        expect(migrated.prepare('SELECT id, project_id, title, phase FROM tasks').all()).toEqual([
          {
            id: 'legacy-task',
            phase: 'RUNNING',
            project_id: 'legacy-project',
            title: 'Legacy Task',
          },
        ]);
        expect(
          migrated
            .prepare(
              `SELECT project_id, canonical_path, path_identity, last_opened_order
               FROM project_roots`,
            )
            .all(),
        ).toEqual([
          {
            canonical_path: 'C:\\repos\\legacy',
            last_opened_order: 7,
            path_identity: 'legacy-root-identity',
            project_id: 'legacy-project',
          },
        ]);
        expect(migrated.prepare('SELECT count(*) AS count FROM task_worktrees').get()).toEqual({
          count: 0,
        });
        expect(
          migrated
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all(),
        ).toEqual([
          { name: 'projects-and-tasks', version: 1 },
          { name: 'project-roots', version: 2 },
          { name: 'task-worktrees', version: 3 },
          { name: 'agent-sessions', version: 4 },
          { name: 'execution-artifacts', version: 5 },
          { name: 'quality-gate-runs', version: 6 },
          { name: 'task-reviews', version: 7 },
          { name: 'task-dependencies', version: 8 },
        ]);
      } finally {
        migrated.close();
      }
    });
  });

  it('upgrades a v3 database without changing its Task Worktree', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        database.exec(`
          CREATE TABLE _agentterm_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT;
          ${projectsAndTasksMigration.sql}
          ${projectRootsMigration.sql}
          ${taskWorktreesMigration.sql}
          INSERT INTO _agentterm_migrations (version, name)
          VALUES
            (1, 'projects-and-tasks'),
            (2, 'project-roots'),
            (3, 'task-worktrees');
          INSERT INTO projects (id, name) VALUES ('project-1', 'AgentTerm');
          INSERT INTO tasks (id, project_id, title, phase)
          VALUES ('task-1', 'project-1', 'Keep Worktree', 'RUNNING');
        `);
        database
          .prepare(
            `INSERT INTO task_worktrees (
             task_id, repository_root_path, worktree_path, path_identity,
             branch_name, base_ref_name, base_commit_id, lifecycle_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'task-1',
            'C:\\repos\\agentterm',
            'C:\\worktrees\\task-1',
            'task-1-identity',
            'agentterm/task-1',
            'refs/heads/main',
            '1111111111111111111111111111111111111111',
            'PRESENT',
          );
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();
      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          migrated.prepare('SELECT task_id, lifecycle_state FROM task_worktrees').all(),
        ).toEqual([{ lifecycle_state: 'PRESENT', task_id: 'task-1' }]);
        expect(migrated.prepare('SELECT count(*) AS count FROM agent_sessions').get()).toEqual({
          count: 0,
        });
        expect(
          migrated
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all(),
        ).toEqual([
          { name: 'projects-and-tasks', version: 1 },
          { name: 'project-roots', version: 2 },
          { name: 'task-worktrees', version: 3 },
          { name: 'agent-sessions', version: 4 },
          { name: 'execution-artifacts', version: 5 },
          { name: 'quality-gate-runs', version: 6 },
          { name: 'task-reviews', version: 7 },
          { name: 'task-dependencies', version: 8 },
        ]);
      } finally {
        migrated.close();
      }
    });
  });

  it('upgrades a v4 database without changing its Task Worktree or Agent Session history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
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
          INSERT INTO _agentterm_migrations (version, name)
          VALUES
            (1, 'projects-and-tasks'),
            (2, 'project-roots'),
            (3, 'task-worktrees'),
            (4, 'agent-sessions');
          INSERT INTO projects (id, name) VALUES ('project-1', 'AgentTerm');
          INSERT INTO tasks (id, project_id, title, phase)
          VALUES ('task-1', 'project-1', 'Keep execution evidence', 'RUNNING');
          INSERT INTO task_worktrees (
            task_id, repository_root_path, worktree_path, path_identity,
            branch_name, base_ref_name, base_commit_id, lifecycle_state
          ) VALUES (
            'task-1', 'C:\\repos\\agentterm', 'C:\\worktrees\\task-1',
            'win32:c:\\worktrees\\task-1', 'agentterm/task/one', 'refs/heads/main',
            '1111111111111111111111111111111111111111', 'PRESENT'
          );
          INSERT INTO agent_sessions (
            id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
          ) VALUES ('session-1', 'task-1', 'codex', 1, 'STARTING', 1800000000000, NULL, 1);
          INSERT INTO agent_session_events (
            session_id, sequence, kind, status, occurred_at, runtime_sequence,
            source, failure_code, fatal, stage, exit_code, exit_reason, signal
          ) VALUES (
            'session-1', 1, 'START_REQUESTED', 'STARTING', 1800000000000, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL
          );
        `);
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();
      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          migrated.prepare('SELECT task_id, lifecycle_state FROM task_worktrees').all(),
        ).toEqual([{ lifecycle_state: 'PRESENT', task_id: 'task-1' }]);
        expect(
          migrated
            .prepare('SELECT id, task_id, agent_id, status, history_sequence FROM agent_sessions')
            .all(),
        ).toEqual([
          {
            agent_id: 'codex',
            history_sequence: 1,
            id: 'session-1',
            status: 'STARTING',
            task_id: 'task-1',
          },
        ]);
        expect(migrated.prepare('SELECT count(*) AS count FROM quality_gate_runs').get()).toEqual({
          count: 0,
        });
        expect(migrated.prepare('SELECT count(*) AS count FROM execution_artifacts').get()).toEqual(
          { count: 0 },
        );
        expect(
          migrated
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all(),
        ).toEqual([
          { name: 'projects-and-tasks', version: 1 },
          { name: 'project-roots', version: 2 },
          { name: 'task-worktrees', version: 3 },
          { name: 'agent-sessions', version: 4 },
          { name: 'execution-artifacts', version: 5 },
          { name: 'quality-gate-runs', version: 6 },
          { name: 'task-reviews', version: 7 },
          { name: 'task-dependencies', version: 8 },
        ]);
      } finally {
        migrated.close();
      }
    });
  });

  it('upgrades a canonical Artifact v5 database without changing Artifact history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        createSchemaThroughV4(database);
        database.exec(executionArtifactsMigration.sql);
        database
          .prepare('INSERT INTO _agentterm_migrations (version, name) VALUES (?, ?)')
          .run(5, 'execution-artifacts');
        database
          .prepare(
            `INSERT INTO execution_artifacts (
               id, task_id, session_id, ordinal, kind, phase, canonical_name,
               format, schema_version, validation, content, created_at
             ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'artifact-1',
            'task-1',
            1,
            'plan',
            'PLANNING',
            'planning/plan.md',
            'markdown',
            1,
            'VALID',
            '# Kế hoạch',
            1_800_000_000_000,
          );
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();
      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          migrated.prepare('SELECT id, content FROM execution_artifacts ORDER BY ordinal').all(),
        ).toEqual([{ content: '# Kế hoạch', id: 'artifact-1' }]);
        expect(migrated.prepare('SELECT count(*) AS count FROM quality_gate_runs').get()).toEqual({
          count: 0,
        });
        expect(
          migrated
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all(),
        ).toEqual([
          { name: 'projects-and-tasks', version: 1 },
          { name: 'project-roots', version: 2 },
          { name: 'task-worktrees', version: 3 },
          { name: 'agent-sessions', version: 4 },
          { name: 'execution-artifacts', version: 5 },
          { name: 'quality-gate-runs', version: 6 },
          { name: 'task-reviews', version: 7 },
          { name: 'task-dependencies', version: 8 },
        ]);
      } finally {
        migrated.close();
      }
    });
  });

  it('reconciles the legacy Quality Gate v5 fork without losing runs and remains idempotent', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        createLegacyQualityGateV5Database(database);
      } finally {
        database.close();
      }

      openSqlitePersistence(databasePath).close();
      openSqlitePersistence(databasePath).close();

      const migrated = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          migrated.prepare('SELECT id, task_id, status, started_at FROM quality_gate_runs').all(),
        ).toEqual([
          {
            id: 'legacy-run',
            started_at: 1_800_000_000_000,
            status: 'RUNNING',
            task_id: 'task-1',
          },
        ]);
        expect(migrated.prepare('SELECT count(*) AS count FROM execution_artifacts').get()).toEqual(
          { count: 0 },
        );
        expect(
          migrated
            .prepare('SELECT version, name, applied_at FROM _agentterm_migrations ORDER BY version')
            .all(),
        ).toEqual([
          expect.objectContaining({ name: 'projects-and-tasks', version: 1 }),
          expect.objectContaining({ name: 'project-roots', version: 2 }),
          expect.objectContaining({ name: 'task-worktrees', version: 3 }),
          expect.objectContaining({ name: 'agent-sessions', version: 4 }),
          expect.objectContaining({ name: 'execution-artifacts', version: 5 }),
          {
            applied_at: '2026-08-01 10:00:00',
            name: 'quality-gate-runs',
            version: 6,
          },
          expect.objectContaining({ name: 'task-reviews', version: 7 }),
          expect.objectContaining({ name: 'task-dependencies', version: 8 }),
        ]);
      } finally {
        migrated.close();
      }
    });
  });

  it('rolls back legacy reconciliation when the Artifact migration cannot be applied', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        createLegacyQualityGateV5Database(database);
        database.exec('CREATE TABLE execution_artifacts (id TEXT PRIMARY KEY) STRICT;');
      } finally {
        database.close();
      }

      expect(() => openSqlitePersistence(databasePath)).toThrow(SqlitePersistenceError);

      const preserved = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          preserved
            .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
            .all(),
        ).toEqual([
          { name: 'projects-and-tasks', version: 1 },
          { name: 'project-roots', version: 2 },
          { name: 'task-worktrees', version: 3 },
          { name: 'agent-sessions', version: 4 },
          { name: 'quality-gate-runs', version: 5 },
        ]);
        expect(preserved.prepare('SELECT id FROM quality_gate_runs').all()).toEqual([
          { id: 'legacy-run' },
        ]);
        expect(
          preserved
            .prepare(
              `SELECT count(*) AS count FROM sqlite_schema
               WHERE type = 'index' AND name = 'agent_sessions_identity_task_index'`,
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        preserved.close();
      }
    });
  });

  it('enforces Worktree lifecycle state and Task foreign-key constraints', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });

      try {
        database
          .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
          .run('project-1', 'AgentTerm');
        database
          .prepare('INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)')
          .run('task-1', 'project-1', 'Manage Worktree', 'RUNNING');
        const insertWorktree = database.prepare(
          `INSERT INTO task_worktrees (
             task_id,
             repository_root_path,
             worktree_path,
             path_identity,
             branch_name,
             base_ref_name,
             base_commit_id,
             lifecycle_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        expect(() =>
          insertWorktree.run(
            'task-1',
            'C:\\repos\\agentterm',
            'C:\\worktrees\\invalid-state',
            'invalid-state-identity',
            'agentterm/task-1-invalid-state',
            'refs/heads/main',
            '1111111111111111111111111111111111111111',
            'BROKEN',
          ),
        ).toThrow();
        expect(() =>
          insertWorktree.run(
            'missing-task',
            'C:\\repos\\agentterm',
            'C:\\worktrees\\orphan',
            'orphan-identity',
            'agentterm/missing-task',
            'refs/heads/main',
            '1111111111111111111111111111111111111111',
            'PROVISIONING',
          ),
        ).toThrow();
        expect(() =>
          insertWorktree.run(
            'task-1',
            'C:\\repos\\agentterm',
            'C:\\worktrees\\invalid-object-id',
            'invalid-object-id-identity',
            'agentterm/task-1-invalid-object-id',
            'refs/heads/main',
            'not-an-object-id',
            'PROVISIONING',
          ),
        ).toThrow();

        insertWorktree.run(
          'task-1',
          'C:\\repos\\agentterm',
          'C:\\worktrees\\task-1',
          'task-1-identity',
          'agentterm/task-1',
          'refs/heads/main',
          '1111111111111111111111111111111111111111',
          'PROVISIONING',
        );

        expect(() => database.prepare('DELETE FROM tasks WHERE id = ?').run('task-1')).toThrow();
        expect(database.prepare('SELECT count(*) AS count FROM task_worktrees').get()).toEqual({
          count: 1,
        });
      } finally {
        database.close();
      }
    });
  });

  it('rejects an applied migration that is not the expected registry prefix', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath);

      try {
        database.exec(`
          CREATE TABLE _agentterm_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT;
          INSERT INTO _agentterm_migrations (version, name)
          VALUES (2, 'project-roots');
        `);
      } finally {
        database.close();
      }

      expect(() => openSqlitePersistence(databasePath)).toThrow(
        'SQLite migration ledger is not an applied prefix of the migration registry.',
      );
    });
  });

  it('rejects a corrupted phase during row-to-Domain mapping', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      openSqlitePersistence(databasePath).close();
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });

      try {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database
          .prepare('INSERT INTO projects (id, name) VALUES (?, ?)')
          .run('project-1', 'AgentTerm');
        database
          .prepare('INSERT INTO tasks (id, project_id, title, phase) VALUES (?, ?, ?, ?)')
          .run('task-1', 'project-1', 'Corrupted task', 'EXITED');
      } finally {
        database.close();
      }

      const persistence = openSqlitePersistence(databasePath);

      try {
        await expect(persistence.tasks.findById('task-1')).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
      } finally {
        persistence.close();
      }
    });
  });

  it('releases the database handle when repository initialization fails', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath);

      try {
        database.exec(`
          CREATE TABLE _agentterm_migrations (
            version INTEGER PRIMARY KEY NOT NULL,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) STRICT;
          INSERT INTO _agentterm_migrations (version, name)
          VALUES (1, 'projects-and-tasks');
        `);
      } finally {
        database.close();
      }

      expect(() => openSqlitePersistence(databasePath)).toThrow();

      const movedDatabasePath = `${databasePath}.moved`;
      renameSync(databasePath, movedDatabasePath);
      expect(existsSync(movedDatabasePath)).toBe(true);
    });
  });
});
