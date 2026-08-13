import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type TaskPlanningRepository } from '@agentterm/application';
import {
  ExecutionArtifactKind,
  TaskPhase,
  createAgentSession,
  createExecutionArtifact,
  createProject,
  createTask,
  recordAgentSessionEvent,
  transitionTask,
} from '@agentterm/domain';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

describe('SQLite Task planning persistence', () => {
  it('atomically accepts the exact latest Plan and preserves Session and Artifact history', async () => {
    await withPlanningPersistence(async (persistence) => {
      const planning = await requirePlanningRepository(persistence.tasks);
      const session = createAgentSession({
        agentId: 'claude',
        createdAt: 10,
        id: 'session-plan-1',
        taskId: 'task-1',
      });
      const exited = recordAgentSessionEvent(session, {
        exitCode: 0,
        kind: 'PROCESS_EXITED',
        occurredAt: 11,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 1,
      });
      await persistence.sessions.insert(session, TaskPhase.PLANNING);
      await persistence.sessions.append(exited, 1);
      const plan = createExecutionArtifact({
        content: '# Plan\n\nImplement the approved slice.',
        createdAt: 20,
        id: 'plan-1',
        kind: ExecutionArtifactKind.PLAN,
        sessionId: session.id,
        taskId: 'task-1',
      });
      await persistence.artifacts.insert(plan, TaskPhase.PLANNING);
      const task = await persistence.tasks.findById('task-1');
      if (task === undefined) throw new Error('fixture task missing');
      const running = transitionTask(task, TaskPhase.RUNNING);

      await planning.acceptPlan(plan, running, [{ historySequence: 2, id: session.id }]);

      await expect(persistence.tasks.findById('task-1')).resolves.toEqual(running);
      await expect(persistence.sessions.listByTaskId('task-1')).resolves.toEqual([exited]);
      await expect(persistence.artifacts.listByTaskId('task-1')).resolves.toEqual([plan]);
      await expect(
        persistence.artifacts.insert(
          createExecutionArtifact({
            content: '# Plan\n\nMust not appear after acceptance.',
            createdAt: 30,
            id: 'plan-after-acceptance',
            kind: ExecutionArtifactKind.PLAN,
            sessionId: session.id,
            taskId: 'task-1',
          }),
          TaskPhase.PLANNING,
        ),
      ).rejects.toBeInstanceOf(SqlitePersistenceError);
    });
  });

  it('rolls back when the selected Plan is stale or Session history changed', async () => {
    await withPlanningPersistence(async (persistence) => {
      const planning = await requirePlanningRepository(persistence.tasks);
      const session = createAgentSession({
        agentId: 'gemini',
        createdAt: 10,
        id: 'session-plan',
        taskId: 'task-1',
      });
      const exited = recordAgentSessionEvent(session, {
        exitCode: 0,
        kind: 'PROCESS_EXITED',
        occurredAt: 11,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 1,
      });
      await persistence.sessions.insert(session, TaskPhase.PLANNING);
      await persistence.sessions.append(exited, 1);
      const first = createExecutionArtifact({
        content: '# Plan\n\nInitial plan.',
        createdAt: 20,
        id: 'plan-1',
        kind: ExecutionArtifactKind.PLAN,
        sessionId: session.id,
        taskId: 'task-1',
      });
      const latest = createExecutionArtifact({
        content: '# Plan\n\nRevised plan.',
        createdAt: 30,
        id: 'plan-2',
        kind: ExecutionArtifactKind.PLAN,
        sessionId: session.id,
        taskId: 'task-1',
      });
      await persistence.artifacts.insert(first, TaskPhase.PLANNING);
      await persistence.artifacts.insert(latest, TaskPhase.PLANNING);
      const task = await persistence.tasks.findById('task-1');
      if (task === undefined) throw new Error('fixture task missing');
      const running = transitionTask(task, TaskPhase.RUNNING);

      await expect(
        planning.acceptPlan(first, running, [{ historySequence: 2, id: session.id }]),
      ).rejects.toBeInstanceOf(SqlitePersistenceError);
      await expect(
        planning.acceptPlan(latest, running, [{ historySequence: 1, id: session.id }]),
      ).rejects.toBeInstanceOf(SqlitePersistenceError);
      await expect(persistence.tasks.findById('task-1')).resolves.toMatchObject({
        phase: TaskPhase.PLANNING,
      });
    });
  });
});

async function withPlanningPersistence(
  run: (persistence: ReturnType<typeof openSqlitePersistence>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-planning-'));
  const persistence = openSqlitePersistence(join(directory, 'agentterm.db'));
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'Planning' }));
    const task = transitionTask(
      createTask({ id: 'task-1', projectId: 'project-1', title: 'Plan safely' }),
      TaskPhase.PLANNING,
    );
    await persistence.tasks.insert(task);
    await run(persistence);
  } finally {
    persistence.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

async function requirePlanningRepository(value: unknown): Promise<TaskPlanningRepository> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('acceptPlan' in value) ||
    typeof value.acceptPlan !== 'function'
  ) {
    throw new TypeError('Task planning persistence is unavailable.');
  }
  return value as TaskPlanningRepository;
}
