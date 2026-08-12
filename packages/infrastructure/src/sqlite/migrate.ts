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

  let appliedMigrations = readAppliedMigrations(database);
  appliedMigrations = reconcileLegacyQualityGateMigration(database, appliedMigrations);
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

function reconcileLegacyQualityGateMigration(
  database: DatabaseSync,
  appliedMigrations: readonly AppliedMigrationRow[],
): AppliedMigrationRow[] {
  if (!isLegacyQualityGateMigrationPrefix(appliedMigrations)) {
    return [...appliedMigrations];
  }

  const executionArtifactsMigration = sqliteMigrations[4];
  const qualityGateRunsMigration = sqliteMigrations[5];
  if (
    executionArtifactsMigration?.version !== 5 ||
    executionArtifactsMigration.name !== 'execution-artifacts' ||
    qualityGateRunsMigration?.version !== 6 ||
    qualityGateRunsMigration.name !== 'quality-gate-runs'
  ) {
    throw new SqlitePersistenceError(
      'SQLite migration registry cannot reconcile the legacy Quality Gate migration.',
    );
  }

  database.exec('BEGIN IMMEDIATE');

  try {
    assertLegacyQualityGateSchema(database, qualityGateRunsMigration.sql);
    const relabeled = database
      .prepare(
        `UPDATE _agentterm_migrations
         SET version = ?
         WHERE version = ? AND name = ?`,
      )
      .run(6, 5, 'quality-gate-runs');
    if (relabeled.changes !== 1 && relabeled.changes !== 1n) {
      throw new SqlitePersistenceError(
        'Legacy Quality Gate migration ledger changed during reconciliation.',
      );
    }

    database.exec(executionArtifactsMigration.sql);
    database
      .prepare('INSERT INTO _agentterm_migrations (version, name) VALUES (?, ?)')
      .run(executionArtifactsMigration.version, executionArtifactsMigration.name);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw new SqlitePersistenceError(
      'Failed to reconcile the legacy Quality Gate SQLite migration.',
      { cause: error },
    );
  }

  return readAppliedMigrations(database);
}

function isLegacyQualityGateMigrationPrefix(
  appliedMigrations: readonly AppliedMigrationRow[],
): boolean {
  if (appliedMigrations.length !== 5) {
    return false;
  }

  return appliedMigrations.every((appliedMigration, index) => {
    if (index === 4) {
      return appliedMigration.version === 5 && appliedMigration.name === 'quality-gate-runs';
    }

    const expectedMigration = sqliteMigrations[index];
    return (
      expectedMigration !== undefined &&
      expectedMigration.version === appliedMigration.version &&
      expectedMigration.name === appliedMigration.name
    );
  });
}

function assertLegacyQualityGateSchema(database: DatabaseSync, migrationSql: string): void {
  assertSchemaObjectMatchesMigration(
    database,
    'table',
    'quality_gate_runs',
    migrationSql,
    'create table quality_gate_runs',
  );
  assertSchemaObjectMatchesMigration(
    database,
    'index',
    'quality_gate_runs_task_ordinal_index',
    migrationSql,
    'create unique index quality_gate_runs_task_ordinal_index',
  );
}

function assertSchemaObjectMatchesMigration(
  database: DatabaseSync,
  type: 'index' | 'table',
  name: string,
  migrationSql: string,
  expectedStatementPrefix: string,
): void {
  const row = database.prepare('SELECT type, sql FROM sqlite_schema WHERE name = ?').get(name);
  const expectedSql = migrationSql
    .split(';')
    .map(normalizeSql)
    .find((statement) => statement.startsWith(expectedStatementPrefix));

  if (
    row === undefined ||
    row.type !== type ||
    typeof row.sql !== 'string' ||
    expectedSql === undefined ||
    normalizeSql(row.sql) !== expectedSql
  ) {
    throw new SqlitePersistenceError(
      `Legacy Quality Gate migration schema object ${name} does not match its ledger.`,
    );
  }
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/g, ' ').trim().toLowerCase();
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
