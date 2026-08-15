import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceLayoutConflictError } from '@agentterm/application';

import { SqlitePersistenceError } from './errors';
import { migrateSqliteDatabase } from './migrate';
import { SqliteWorkspaceLayoutRepository } from './workspace-layout-repository';

function withTempDatabase(run: (path: string) => Promise<void>): Promise<void> {
  return (async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentterm-workspace-layout-'));
    const path = join(directory, 'agentterm.db');
    try {
      await run(path);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  })();
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE _agentterm_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);
  migrateSqliteDatabase(database);
}

const sampleLayout = () => ({
  activeTabId: 'tab:task-1',
  tabs: [
    {
      activePaneId: 'pane:task-1:main',
      id: 'tab:task-1',
      panes: [
        { id: 'pane:task-1:main', sessionId: 'session-1', taskId: 'task-1' },
      ],
      taskId: 'task-1',
    },
  ],
});

describe('SqliteWorkspaceLayoutRepository', () => {
  let repository: SqliteWorkspaceLayoutRepository;
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
    createSchema(database);
    repository = new SqliteWorkspaceLayoutRepository(database);
  });

  it('returns undefined when no layout has been saved', async () => {
    expect(await repository.load()).toBeUndefined();
  });

  it('persists the layout atomically and round-trips it', async () => {
    const result = await repository.save({ expectedRevision: 0, layout: sampleLayout() });
    expect(result.revision).toBe(1);
    const loaded = await repository.load();
    expect(loaded?.revision).toBe(1);
    expect(loaded?.layout).toEqual(sampleLayout());
  });

  it('rejects saves that miss the expected revision', async () => {
    await repository.save({ expectedRevision: 0, layout: sampleLayout() });
    await expect(
      repository.save({ expectedRevision: 5, layout: sampleLayout() }),
    ).rejects.toBeInstanceOf(WorkspaceLayoutConflictError);
  });

  it('preserves prior history after a conflict', async () => {
    await repository.save({ expectedRevision: 0, layout: sampleLayout() });
    await expect(
      repository.save({ expectedRevision: 5, layout: sampleLayout() }),
    ).rejects.toBeInstanceOf(WorkspaceLayoutConflictError);
    const loaded = await repository.load();
    expect(loaded?.revision).toBe(1);
  });

  it('throws SqlitePersistenceError when stored JSON is corrupt', async () => {
    await repository.save({ expectedRevision: 0, layout: sampleLayout() });
    database.exec(`UPDATE workspace_layout SET layout_json = 'not-json'`);
    await expect(repository.load()).rejects.toBeInstanceOf(SqlitePersistenceError);
  });
});

describe('SqliteWorkspaceLayoutRepository disk persistence', () => {
  it('round-trips after reopening the database', async () => {
    await withTempDatabase(async (path) => {
      const first = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      createSchema(first);
      const repo = new SqliteWorkspaceLayoutRepository(first);
      await repo.save({ expectedRevision: 0, layout: sampleLayout() });
      first.close();
      const second = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      const reopened = new SqliteWorkspaceLayoutRepository(second);
      const loaded = await reopened.load();
      expect(loaded?.revision).toBe(1);
      expect(loaded?.layout).toEqual(sampleLayout());
      second.close();
    });
  });
});
