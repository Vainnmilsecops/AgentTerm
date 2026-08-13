import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  TaskPhase,
  createAgentSession,
  createTaskDependency,
  transitionTask,
} from '@agentterm/domain';
import { createProject, createTask } from '@agentterm/application';

import { openSqlitePersistence } from './index';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('SQLite Task Dependency persistence', () => {
  it('persists deterministic add, list, and remove history across reopen', async () => {
    const fixture = await createFixture();
    const first = openSqlitePersistence(fixture.databasePath);
    const dependency = createTaskDependency({ dependencyTaskId: 'task-b', taskId: 'task-a' });

    try {
      await first.taskDependencies.add(dependency);
      await expect(first.taskDependencies.listByTaskId('task-a')).resolves.toEqual([dependency]);
    } finally {
      first.close();
    }

    const reopened = openSqlitePersistence(fixture.databasePath);
    try {
      await expect(reopened.taskDependencies.listByProjectId('project-1')).resolves.toEqual([
        dependency,
      ]);
      await expect(reopened.taskDependencies.remove(dependency)).resolves.toBe(true);
      await expect(reopened.taskDependencies.remove(dependency)).resolves.toBe(false);
    } finally {
      reopened.close();
    }
  });

  it('rejects self, duplicate, cross-Project, and transitive-cycle dependencies atomically', async () => {
    const fixture = await createFixture();
    const persistence = openSqlitePersistence(fixture.databasePath);
    const aToB = createTaskDependency({ dependencyTaskId: 'task-b', taskId: 'task-a' });
    const bToC = createTaskDependency({ dependencyTaskId: 'task-c', taskId: 'task-b' });

    try {
      await persistence.taskDependencies.add(aToB);
      await persistence.taskDependencies.add(bToC);

      await expect(persistence.taskDependencies.add(aToB)).rejects.toMatchObject({
        name: 'InvalidTaskDependencyError',
        reason: 'DUPLICATE',
      });
      await expect(
        persistence.taskDependencies.add({ dependencyTaskId: 'task-a', taskId: 'task-a' }),
      ).rejects.toMatchObject({ name: 'InvalidTaskDependencyError', reason: 'SELF' });
      await expect(
        persistence.taskDependencies.add({ dependencyTaskId: 'task-other', taskId: 'task-a' }),
      ).rejects.toMatchObject({ name: 'TaskDependencyProjectMismatchError' });
      await expect(
        persistence.taskDependencies.add({ dependencyTaskId: 'task-a', taskId: 'task-c' }),
      ).rejects.toMatchObject({ name: 'InvalidTaskDependencyError', reason: 'CYCLE' });
      await expect(persistence.taskDependencies.listByProjectId('project-1')).resolves.toEqual([
        aToB,
        bToC,
      ]);
      const rawDatabase = new DatabaseSync(fixture.databasePath, {
        enableForeignKeyConstraints: true,
      });
      try {
        expect(() =>
          rawDatabase
            .prepare(
              `INSERT INTO task_dependencies (task_id, dependency_task_id, project_id)
               VALUES (?, ?, ?)`,
            )
            .run('task-c', 'task-a', 'project-1'),
        ).toThrow('task_dependency_cycle');
      } finally {
        rawDatabase.close();
      }
    } finally {
      persistence.close();
    }
  });

  it('atomically rejects a new Agent Session while a required Task is incomplete', async () => {
    const fixture = await createFixture();
    const persistence = openSqlitePersistence(fixture.databasePath);
    try {
      const task = await persistence.tasks.findById('task-a');
      if (task === undefined) throw new Error('Fixture Task is missing.');
      const planningTask = transitionTask(task, TaskPhase.PLANNING);
      await persistence.tasks.update(planningTask, TaskPhase.BACKLOG);
      await persistence.taskDependencies.add(
        createTaskDependency({ dependencyTaskId: 'task-b', taskId: 'task-a' }),
      );

      await expect(
        persistence.sessions.insert(
          createAgentSession({
            agentId: 'codex',
            createdAt: 1_800_000_000_000,
            id: 'session-1',
            taskId: 'task-a',
          }),
          TaskPhase.PLANNING,
        ),
      ).rejects.toThrow('incomplete Task dependencies');
      await expect(persistence.sessions.listByTaskId('task-a')).resolves.toEqual([]);
    } finally {
      persistence.close();
    }
  });
});

async function createFixture(): Promise<{ readonly databasePath: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-task-dependencies-'));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, 'agentterm.db');
  const persistence = openSqlitePersistence(databasePath);
  await createProject({ id: 'project-1', name: 'Project one' }, persistence.projects);
  await createProject({ id: 'project-2', name: 'Project two' }, persistence.projects);
  for (const [id, projectId] of [
    ['task-a', 'project-1'],
    ['task-b', 'project-1'],
    ['task-c', 'project-1'],
    ['task-other', 'project-2'],
  ] as const) {
    await createTask({ id, projectId, title: id }, persistence.projects, persistence.tasks);
  }
  persistence.close();
  return { databasePath };
}
