import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ApplicationSettingsConflictError } from '@agentterm/application';
import { createApplicationSettings } from '@agentterm/domain';
import { describe, expect, it } from 'vitest';

import { openSqlitePersistence } from './index';
import { projectsAndTasksMigration } from './sqlite/migrations/0001-projects-and-tasks';
import { projectRootsMigration } from './sqlite/migrations/0002-project-roots';
import { taskWorktreesMigration } from './sqlite/migrations/0003-task-worktrees';
import { agentSessionsMigration } from './sqlite/migrations/0004-agent-sessions';
import { executionArtifactsMigration } from './sqlite/migrations/0005-execution-artifacts';
import { qualityGateRunsMigration } from './sqlite/migrations/0006-quality-gate-runs';
import { taskReviewsMigration } from './sqlite/migrations/0007-task-reviews';
import { taskDependenciesMigration } from './sqlite/migrations/0008-task-dependencies';
import { pullRequestsMigration } from './sqlite/migrations/0009-pull-requests';

async function withDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-settings-'));
  try {
    await run(join(directory, 'agentterm.db'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe('SQLite Application Settings persistence', () => {
  it('seeds backward-compatible defaults for a new database', async () => {
    await withDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);
      try {
        await expect(persistence.settings.get()).resolves.toEqual(createApplicationSettings());
      } finally {
        persistence.close();
      }
    });
  });

  it('atomically persists executable overrides and terminal preferences across restart', async () => {
    await withDatabase(async (databasePath) => {
      const first = openSqlitePersistence(databasePath);
      const next = createApplicationSettings({
        agentExecutables: [
          { agentId: 'claude', executablePath: 'C:\\Tools\\claude.exe' },
          { agentId: 'gemini', executablePath: 'C:\\Tools\\gemini.cmd' },
        ],
        defaultAgentId: 'claude',
        revision: 1,
        terminalFontSize: 17,
      });
      await first.settings.update(next, 0);
      first.close();

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.settings.get()).resolves.toEqual(next);
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects stale writers without partially replacing executable overrides', async () => {
    await withDatabase(async (databasePath) => {
      const first = openSqlitePersistence(databasePath);
      const second = openSqlitePersistence(databasePath);
      try {
        const accepted = createApplicationSettings({
          agentExecutables: [{ agentId: 'codex', executablePath: 'C:\\accepted.exe' }],
          revision: 1,
        });
        await first.settings.update(accepted, 0);

        await expect(
          second.settings.update(
            createApplicationSettings({
              agentExecutables: [{ agentId: 'gemini', executablePath: 'C:\\stale.exe' }],
              defaultAgentId: 'gemini',
              revision: 1,
            }),
            0,
          ),
        ).rejects.toBeInstanceOf(ApplicationSettingsConflictError);
        await expect(second.settings.get()).resolves.toEqual(accepted);
      } finally {
        second.close();
        first.close();
      }
    });
  });

  it('upgrades an existing v9 database by adding defaults without changing prior data', async () => {
    await withDatabase(async (databasePath) => {
      const database = new DatabaseSync(databasePath);
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
        ${taskReviewsMigration.sql}
        ${taskDependenciesMigration.sql}
        ${pullRequestsMigration.sql}
        INSERT INTO _agentterm_migrations (version, name)
        VALUES
          (1, 'projects-and-tasks'), (2, 'project-roots'), (3, 'task-worktrees'),
          (4, 'agent-sessions'), (5, 'execution-artifacts'), (6, 'quality-gate-runs'),
          (7, 'task-reviews'), (8, 'task-dependencies'), (9, 'pull-requests');
        INSERT INTO projects (id, name) VALUES ('project-before-settings', 'Existing project');
      `);
      database.close();

      const persistence = openSqlitePersistence(databasePath);
      try {
        await expect(persistence.settings.get()).resolves.toEqual(createApplicationSettings());
        await expect(persistence.projects.findById('project-before-settings')).resolves.toEqual({
          id: 'project-before-settings',
          name: 'Existing project',
        });
      } finally {
        persistence.close();
      }
    });
  });
});
