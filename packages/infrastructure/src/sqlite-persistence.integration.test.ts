import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createProject,
  createTask,
  EntityAlreadyExistsError,
  transitionTask,
} from '@agentterm/application';
import {
  createProject as createDomainProject,
  createTask as createDomainTask,
  TaskPhase,
  transitionTask as transitionDomainTask,
} from '@agentterm/domain';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-sqlite-'));
  const databasePath = join(directory, 'agentterm.db');

  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe('SQLite persistence', () => {
  it('persists and restores Project and Task state across connections', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        const project = await createProject(
          { id: 'project-1', name: 'AgentTerm' },
          persistence.projects,
        );
        const backlog = await createTask(
          {
            brief: 'Persist the user goal and acceptance criteria for every future Session.',
            id: 'task-1',
            projectId: project.id,
            title: 'Persist task state',
          },
          persistence.projects,
          persistence.tasks,
        );
        const planning = await transitionTask(
          { taskId: backlog.id, to: TaskPhase.PLANNING },
          persistence.tasks,
        );

        await expect(persistence.projects.findById(project.id)).resolves.toEqual(project);
        await expect(persistence.tasks.findById(backlog.id)).resolves.toEqual(planning);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);

      try {
        await expect(reopened.projects.findById('project-1')).resolves.toEqual({
          id: 'project-1',
          name: 'AgentTerm',
        });
        await expect(reopened.tasks.findById('task-1')).resolves.toEqual({
          brief: 'Persist the user goal and acceptance criteria for every future Session.',
          id: 'task-1',
          phase: TaskPhase.PLANNING,
          projectId: 'project-1',
          title: 'Persist task state',
        });
      } finally {
        reopened.close();
      }
    });
  });

  it('round-trips every persisted TaskPhase through Domain mapping', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        const project = await createProject(
          { id: 'project-1', name: 'AgentTerm' },
          persistence.projects,
        );
        let task = await createTask(
          {
            id: 'task-1',
            projectId: project.id,
            title: 'Round-trip task phases',
          },
          persistence.projects,
          persistence.tasks,
        );

        const transitions = Object.freeze([
          TaskPhase.PLANNING,
          TaskPhase.RUNNING,
          TaskPhase.REVIEW,
          TaskPhase.DONE,
        ]);

        for (const to of transitions) {
          const expectedPhase = task.phase;
          task = transitionDomainTask(task, to);
          await persistence.tasks.update(task, expectedPhase);
          await expect(persistence.tasks.findById(task.id)).resolves.toMatchObject({
            phase: to,
          });
        }
      } finally {
        persistence.close();
      }
    });
  });

  it('enforces insert and update repository contracts', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        const project = createDomainProject({ id: 'project-1', name: 'AgentTerm' });
        const task = createDomainTask({
          id: 'task-1',
          projectId: project.id,
          title: 'Repository contracts',
        });

        await persistence.projects.insert(project);
        await expect(persistence.projects.insert(project)).rejects.toBeInstanceOf(
          EntityAlreadyExistsError,
        );
        await persistence.tasks.insert(task);
        await expect(persistence.tasks.insert(task)).rejects.toBeInstanceOf(
          EntityAlreadyExistsError,
        );
        await expect(
          persistence.tasks.update({ ...task, id: 'missing-task' }, task.phase),
        ).rejects.toBeInstanceOf(SqlitePersistenceError);

        await expect(persistence.projects.findById(project.id)).resolves.toEqual(project);
        await expect(persistence.tasks.findById(task.id)).resolves.toEqual(task);
      } finally {
        persistence.close();
      }
    });
  });

  it('rejects a stale Task update instead of overwriting a newer Review phase', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        const project = createDomainProject({ id: 'project-1', name: 'AgentTerm' });
        const backlog = createDomainTask({
          id: 'task-1',
          projectId: project.id,
          title: 'Preserve newer phase',
        });
        const planning = transitionDomainTask(backlog, TaskPhase.PLANNING);
        const running = transitionDomainTask(planning, TaskPhase.RUNNING);
        const review = transitionDomainTask(running, TaskPhase.REVIEW);
        await persistence.projects.insert(project);
        await persistence.tasks.insert(backlog);
        await persistence.tasks.update(planning, TaskPhase.BACKLOG);
        await persistence.tasks.update(running, TaskPhase.PLANNING);
        await persistence.tasks.update(review, TaskPhase.RUNNING);

        await expect(persistence.tasks.update(running, TaskPhase.PLANNING)).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
        await expect(persistence.tasks.findById(backlog.id)).resolves.toEqual(review);
      } finally {
        persistence.close();
      }
    });
  });

  it('lists every Task for one Project in deterministic identity order', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        const firstProject = createDomainProject({ id: 'project-1', name: 'Dự án chính' });
        const secondProject = createDomainProject({ id: 'project-2', name: 'Other' });
        await persistence.projects.insert(firstProject);
        await persistence.projects.insert(secondProject);
        await persistence.tasks.insert(
          createDomainTask({ id: 'task-b', projectId: firstProject.id, title: 'Việc B' }),
        );
        await persistence.tasks.insert(
          createDomainTask({ id: 'task-a', projectId: firstProject.id, title: 'Việc A' }),
        );
        await persistence.tasks.insert(
          createDomainTask({ id: 'task-other', projectId: secondProject.id, title: 'Other' }),
        );

        await expect(persistence.tasks.listByProjectId(firstProject.id)).resolves.toMatchObject([
          { id: 'task-a', projectId: firstProject.id, title: 'Việc A' },
          { id: 'task-b', projectId: firstProject.id, title: 'Việc B' },
        ]);
      } finally {
        persistence.close();
      }
    });
  });

  it('enables Project foreign-key enforcement on the repository connection', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      const persistence = openSqlitePersistence(databasePath);

      try {
        const orphanTask = createDomainTask({
          id: 'orphan-task',
          projectId: 'missing-project',
          title: 'Must not be persisted',
        });

        await expect(persistence.tasks.insert(orphanTask)).rejects.toThrow();
        await expect(persistence.tasks.findById(orphanTask.id)).resolves.toBeUndefined();
      } finally {
        persistence.close();
      }
    });
  });
});
