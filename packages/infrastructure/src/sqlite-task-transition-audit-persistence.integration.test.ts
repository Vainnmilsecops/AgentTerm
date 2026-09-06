import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EntityAlreadyExistsError, type TaskTransitionLog } from '@agentterm/application';
import {
  createProject,
  createTask,
  createTaskTransitionAudit,
  TaskPhase,
  TaskTransitionTrigger,
  type TaskTransitionAudit,
} from '@agentterm/domain';
import { describe, expect, it } from 'vitest';

import { openSqlitePersistence } from './index';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-task-transition-audit-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function seedTask(databasePath: string): Promise<void> {
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
    await persistence.tasks.insert(
      createTask({ id: 'task-1', projectId: 'project-1', title: 'Audit test' }),
    );
  } finally {
    persistence.close();
  }
}

describe('SQLite Task Transition Audit persistence', () => {
  it('round-trips a MANUAL transition row across connections', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);

      const persistence = openSqlitePersistence(databasePath);
      const audit: TaskTransitionAudit = createTaskTransitionAudit({
        createdAt: 1_700_000_000_000,
        fromPhase: TaskPhase.BACKLOG,
        id: 'audit-manual-1',
        taskId: 'task-1',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.MANUAL,
      });
      try {
        await persistence.taskTransitions.append(audit);
        await expect(persistence.taskTransitions.listByTaskId('task-1')).resolves.toEqual([audit]);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.taskTransitions.listByTaskId('task-1')).resolves.toEqual([audit]);
      } finally {
        reopened.close();
      }
    });
  });

  it('round-trips a RESEARCH_AUTO_ADVANCE row with an artifact id', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);

      const persistence = openSqlitePersistence(databasePath);
      const audit = createTaskTransitionAudit({
        artifactId: 'artifact-1',
        createdAt: 1_700_000_001_000,
        fromPhase: TaskPhase.BACKLOG,
        id: 'audit-auto-1',
        taskId: 'task-1',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE,
      });
      try {
        await persistence.taskTransitions.append(audit);
        await expect(persistence.taskTransitions.listByTaskId('task-1')).resolves.toEqual([audit]);
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects a duplicate audit id with EntityAlreadyExistsError', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);

      const persistence = openSqlitePersistence(databasePath);
      const audit = createTaskTransitionAudit({
        createdAt: 1_700_000_000_000,
        fromPhase: TaskPhase.BACKLOG,
        id: 'audit-dup',
        taskId: 'task-1',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.MANUAL,
      });
      try {
        await persistence.taskTransitions.append(audit);
        await expect(persistence.taskTransitions.append(audit)).rejects.toBeInstanceOf(
          EntityAlreadyExistsError,
        );
      } finally {
        persistence.close();
      }
    });
  });

  it('returns an empty array for a task with no transitions', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await expect(persistence.taskTransitions.listByTaskId('task-1')).resolves.toEqual([]);
      } finally {
        persistence.close();
      }
    });
  });

  it('satisfies the TaskTransitionLog port shape', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        // Compile-time check that the runtime value implements the port.
        const log: TaskTransitionLog = persistence.taskTransitions;
        expect(typeof log.append).toBe('function');
        expect(typeof log.listByTaskId).toBe('function');
      } finally {
        persistence.close();
      }
    });
  });
});
