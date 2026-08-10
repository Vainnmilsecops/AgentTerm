import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-sqlite-migration-'));
  const databasePath = join(directory, 'agentterm.db');

  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe('SQLite migrations', () => {
  it('applies the current schema once with only Project and Task tables', async () => {
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
        const taskProjectIndex = database
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'index' AND name = 'tasks_project_id_index'`,
          )
          .get();

        expect(tables).toEqual(['_agentterm_migrations', 'projects', 'tasks']);
        expect(migrations).toEqual([{ name: 'projects-and-tasks', version: 1 }]);
        expect(taskProjectIndex).toEqual({ name: 'tasks_project_id_index' });
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
