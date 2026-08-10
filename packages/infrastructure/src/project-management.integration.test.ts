import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  listRecentProjects,
  openProject,
  type LocalProject,
  type RecordProjectOpenInput,
} from '@agentterm/application';
import { createProject } from '@agentterm/domain';

import { LocalGitProjectDiscovery, openSqlitePersistence, SqlitePersistenceError } from './index';

async function withTemporaryWorkspace(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-project-management-'));

  try {
    await run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function initializeGitRepository(path: string): void {
  execFileSync('git', ['init', '--quiet', path], {
    cwd: dirname(process.execPath),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function projectOpenRecord(
  id: string,
  name: string,
  rootPath: string,
  pathIdentity: string,
): RecordProjectOpenInput {
  return {
    pathIdentity,
    project: createProject({ id, name }),
    rootPath,
  };
}

describe('Project Management persistence', () => {
  it('opens real Git repositories, deduplicates a nested reopen, and restores MRU order', async () => {
    await withTemporaryWorkspace(async (directory) => {
      const firstRepositoryPath = join(directory, 'First Repository');
      const secondRepositoryPath = join(directory, 'Second Repository');
      const nestedPath = join(firstRepositoryPath, 'packages', 'domain');
      const databasePath = join(directory, 'agentterm.db');
      initializeGitRepository(firstRepositoryPath);
      initializeGitRepository(secondRepositoryPath);
      mkdirSync(nestedPath, { recursive: true });
      const discovery = new LocalGitProjectDiscovery();
      const persistence = openSqlitePersistence(databasePath);
      let expectedRecent: readonly LocalProject[];

      try {
        const first = await openProject(
          { path: firstRepositoryPath },
          discovery,
          persistence.projects,
        );
        const second = await openProject(
          { path: secondRepositoryPath },
          discovery,
          persistence.projects,
        );
        const reopened = await openProject({ path: nestedPath }, discovery, persistence.projects);

        expect(reopened).toEqual(first);
        expectedRecent = [first, second];
        await expect(listRecentProjects(persistence.projects)).resolves.toEqual(expectedRecent);
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath, { readOnly: true });

      try {
        expect(database.prepare('SELECT count(*) AS count FROM projects').get()).toEqual({
          count: 2,
        });
        expect(database.prepare('SELECT count(*) AS count FROM project_roots').get()).toEqual({
          count: 2,
        });
      } finally {
        database.close();
      }

      const reopenedPersistence = openSqlitePersistence(databasePath);

      try {
        await expect(listRecentProjects(reopenedPersistence.projects)).resolves.toEqual(
          expectedRecent,
        );
      } finally {
        reopenedPersistence.close();
      }
    });
  });

  it('uses path identity as the final duplicate guard', async () => {
    await withTemporaryWorkspace(async (directory) => {
      const persistence = openSqlitePersistence(join(directory, 'agentterm.db'));
      const first = projectOpenRecord(
        'project-1',
        'First Name',
        'D:\\Repositories\\AgentTerm',
        'win32:d:\\repositories\\agentterm',
      );
      const duplicate = projectOpenRecord(
        'project-2',
        'Replacement Name',
        'D:\\Repositories\\AGENTTERM',
        first.pathIdentity,
      );

      try {
        const opened = await persistence.projects.recordOpen(first);
        const reopened = await persistence.projects.recordOpen(duplicate);

        expect(reopened).toEqual(opened);
        await expect(persistence.projects.findById('project-2')).resolves.toBeUndefined();
        await expect(persistence.projects.listRecent()).resolves.toEqual([opened]);
      } finally {
        persistence.close();
      }
    });
  });

  it('rolls back a new Project when its canonical path conflicts', async () => {
    await withTemporaryWorkspace(async (directory) => {
      const persistence = openSqlitePersistence(join(directory, 'agentterm.db'));
      const rootPath = 'D:\\Repositories\\AgentTerm';
      const first = projectOpenRecord(
        'project-1',
        'AgentTerm',
        rootPath,
        'win32:d:\\repositories\\agentterm',
      );
      const conflict = projectOpenRecord(
        'project-2',
        'Conflicting Project',
        rootPath,
        'win32:d:\\repositories\\different',
      );

      try {
        await persistence.projects.recordOpen(first);

        await expect(persistence.projects.recordOpen(conflict)).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
        await expect(persistence.projects.findById('project-2')).resolves.toBeUndefined();
        await expect(persistence.projects.listRecent()).resolves.toHaveLength(1);
      } finally {
        persistence.close();
      }
    });
  });
});
