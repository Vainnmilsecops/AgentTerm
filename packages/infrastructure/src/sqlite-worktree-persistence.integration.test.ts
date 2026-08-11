import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProject, createTask } from '@agentterm/domain';

import { openSqlitePersistence } from './index';

interface WorktreeReservationFixture {
  readonly baseCommitId: string;
  readonly baseRefName: string;
  readonly branchName: string;
  readonly pathIdentity: string;
  readonly repositoryRootPath: string;
  readonly taskId: string;
  readonly worktreePath: string;
}

const primaryReservation: WorktreeReservationFixture = {
  baseCommitId: '1111111111111111111111111111111111111111',
  baseRefName: 'refs/heads/main',
  branchName: 'agentterm/task-1',
  pathIdentity: 'worktree-path-identity-1',
  repositoryRootPath: 'C:\\repos\\agentterm',
  taskId: 'task-1',
  worktreePath: 'C:\\worktrees\\task-1',
};

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-sqlite-worktree-'));
  const databasePath = join(directory, 'agentterm.db');

  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function seedTasks(
  persistence: ReturnType<typeof openSqlitePersistence>,
  taskIds: readonly string[],
): Promise<void> {
  await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));

  for (const taskId of taskIds) {
    await persistence.tasks.insert(
      createTask({ id: taskId, projectId: 'project-1', title: `Manage ${taskId} Worktree` }),
    );
  }
}

describe('SQLite Task Worktree persistence', () => {
  it('round-trips lifecycle changes and retains REMOVED metadata as a tombstone', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        await seedTasks(persistence, ['task-1']);

        await expect(persistence.worktrees.insertReservation(primaryReservation)).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'PROVISIONING',
        });
        await expect(
          persistence.worktrees.transitionState('task-1', 'PROVISIONING', 'PRESENT'),
        ).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'PRESENT',
        });
        await expect(
          persistence.worktrees.transitionState('task-1', 'PRESENT', 'REMOVING'),
        ).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'REMOVING',
        });
        await expect(
          persistence.worktrees.transitionState('task-1', 'REMOVING', 'REMOVED'),
        ).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'REMOVED',
        });
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);

      try {
        await expect(reopened.worktrees.findByTaskId('task-1')).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'REMOVED',
        });
      } finally {
        reopened.close();
      }
    });
  });

  const duplicateCases: ReadonlyArray<{
    readonly candidate: WorktreeReservationFixture;
    readonly name: string;
  }> = [
    {
      candidate: {
        ...primaryReservation,
        branchName: 'agentterm/other-branch',
        pathIdentity: 'other-path-identity',
        worktreePath: 'C:\\worktrees\\other-path',
      },
      name: 'Task identity',
    },
    {
      candidate: {
        ...primaryReservation,
        branchName: 'agentterm/task-2',
        pathIdentity: 'worktree-path-identity-2',
        taskId: 'task-2',
      },
      name: 'Worktree path',
    },
    {
      candidate: {
        ...primaryReservation,
        branchName: 'agentterm/task-2',
        taskId: 'task-2',
        worktreePath: 'C:\\worktrees\\task-2',
      },
      name: 'path identity',
    },
    {
      candidate: {
        ...primaryReservation,
        pathIdentity: 'worktree-path-identity-2',
        taskId: 'task-2',
        worktreePath: 'C:\\worktrees\\task-2',
      },
      name: 'branch within a repository root',
    },
  ];

  it.each(duplicateCases)('rejects a duplicate $name reservation', async ({ candidate }) => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        await seedTasks(persistence, ['task-1', 'task-2']);
        await persistence.worktrees.insertReservation(primaryReservation);

        await expect(persistence.worktrees.insertReservation(candidate)).rejects.toMatchObject({
          name: 'TaskWorktreeMetadataConflictError',
        });
        await expect(persistence.worktrees.findByTaskId('task-1')).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'PROVISIONING',
        });

        if (candidate.taskId === 'task-2') {
          await expect(persistence.worktrees.findByTaskId('task-2')).resolves.toBeUndefined();
        }
      } finally {
        persistence.close();
      }
    });
  });

  it('allows the same branch name when repository roots differ', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        await seedTasks(persistence, ['task-1', 'task-2']);
        await persistence.worktrees.insertReservation(primaryReservation);
        const otherRepositoryReservation = {
          ...primaryReservation,
          pathIdentity: 'worktree-path-identity-2',
          repositoryRootPath: 'C:\\repos\\other',
          taskId: 'task-2',
          worktreePath: 'C:\\worktrees\\task-2',
        };

        await expect(
          persistence.worktrees.insertReservation(otherRepositoryReservation),
        ).resolves.toEqual({
          ...otherRepositoryReservation,
          lifecycleState: 'PROVISIONING',
        });
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects an invalid base commit before persisting a reservation', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        await seedTasks(persistence, ['task-1']);

        await expect(
          persistence.worktrees.insertReservation({
            ...primaryReservation,
            baseCommitId: 'not-an-object-id',
          }),
        ).rejects.toMatchObject({ name: 'SqlitePersistenceError' });
        await expect(persistence.worktrees.findByTaskId('task-1')).resolves.toBeUndefined();
      } finally {
        persistence.close();
      }
    });
  });

  it('reports a missing Task foreign key as persistence failure, not metadata contention', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        await expect(
          persistence.worktrees.insertReservation({
            ...primaryReservation,
            taskId: 'missing-task',
          }),
        ).rejects.toMatchObject({ name: 'SqlitePersistenceError' });
        await expect(persistence.worktrees.findByTaskId('missing-task')).resolves.toBeUndefined();
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects stale and missing compare-and-set transitions without changing metadata', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        await seedTasks(persistence, ['task-1']);
        await persistence.worktrees.insertReservation(primaryReservation);

        await expect(
          persistence.worktrees.transitionState('task-1', 'PRESENT', 'REMOVING'),
        ).rejects.toMatchObject({ name: 'TaskWorktreeMetadataConflictError' });
        await expect(
          persistence.worktrees.transitionState('missing-task', 'PROVISIONING', 'PRESENT'),
        ).rejects.toMatchObject({ name: 'TaskWorktreeMetadataConflictError' });
        await expect(persistence.worktrees.findByTaskId('task-1')).resolves.toEqual({
          ...primaryReservation,
          lifecycleState: 'PROVISIONING',
        });
      } finally {
        persistence.close();
      }
    });
  });
});
