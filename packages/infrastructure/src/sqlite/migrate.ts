import type { DatabaseSync } from 'node:sqlite';

import { SqlitePersistenceError } from './errors';
import { sqliteMigrations } from './migrations';

interface AppliedMigrationRow {
  readonly name: string;
  readonly version: number;
}

const createMigrationLedgerSql = `
  CREATE TABLE IF NOT EXISTS _agentterm_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;
`;

export function migrateSqliteDatabase(database: DatabaseSync): void {
  database.exec(createMigrationLedgerSql);

  const appliedMigrations = readAppliedMigrations(database);
  validateAppliedMigrations(appliedMigrations);
  const appliedVersions = new Set(appliedMigrations.map(({ version }) => version));
  const recordMigration = database.prepare(
    'INSERT INTO _agentterm_migrations (version, name) VALUES (?, ?)',
  );

  for (const migration of sqliteMigrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    database.exec('BEGIN IMMEDIATE');

    try {
      database.exec(migration.sql);
      recordMigration.run(migration.version, migration.name);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new SqlitePersistenceError(
        `Failed to apply SQLite migration ${migration.version} (${migration.name}).`,
        { cause: error },
      );
    }
  }
}

function readAppliedMigrations(database: DatabaseSync): AppliedMigrationRow[] {
  const rows = database
    .prepare('SELECT version, name FROM _agentterm_migrations ORDER BY version')
    .all();

  return rows.map((row) => {
    if (typeof row.version !== 'number' || typeof row.name !== 'string') {
      throw new SqlitePersistenceError('SQLite migration ledger contains an invalid row.');
    }

    return { name: row.name, version: row.version };
  });
}

function validateAppliedMigrations(appliedMigrations: readonly AppliedMigrationRow[]): void {
  for (const [index, appliedMigration] of appliedMigrations.entries()) {
    const expectedMigration = sqliteMigrations[index];

    if (
      expectedMigration === undefined ||
      expectedMigration.version !== appliedMigration.version ||
      expectedMigration.name !== appliedMigration.name
    ) {
      throw new SqlitePersistenceError(
        'SQLite migration ledger is not an applied prefix of the migration registry.',
      );
    }
  }
}
