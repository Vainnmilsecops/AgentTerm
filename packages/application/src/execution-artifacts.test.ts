import {
  AgentSessionStatus,
  createAgentSession,
  createTask as createDomainTask,
  ExecutionArtifactKind,
  recordAgentSessionEvent,
  TaskPhase,
  transitionTask,
  type AgentSession,
  type ExecutionArtifact,
  type Task,
} from '@agentterm/domain';
import { describe, expect, it } from 'vitest';

import {
  ArtifactProvenanceError,
  createExecutionArtifact,
  EntityNotFoundError,
  getExecutionArtifact,
  listTaskExecutionArtifacts,
  type AgentSessionRepository,
  type ExecutionArtifactRepository,
  type TaskRepository,
} from './index';

describe('execution artifact use cases', () => {
  it('creates a session-produced artifact without changing the Task phase', async () => {
    const task = taskInPhase(TaskPhase.RUNNING);
    const session = exitedSession('session-1', task.id);
    const tasks = taskRepository(task);
    const sessions = sessionRepository(session);
    const artifacts = artifactRepository();

    const artifact = await createExecutionArtifact(
      {
        content: '# Execution Summary\n\nĐã lưu lịch sử artifact.',
        createdAt: 30,
        id: 'artifact-1',
        kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
        sessionId: session.id,
        taskId: task.id,
      },
      tasks,
      sessions,
      artifacts,
    );

    expect(artifact.sessionId).toBe(session.id);
    expect(await artifacts.findById('artifact-1')).toEqual(artifact);
    expect((await tasks.findById(task.id))?.phase).toBe(TaskPhase.RUNNING);
  });

  it('rejects a Session from another Task before persisting provenance', async () => {
    const task = taskInPhase(TaskPhase.RUNNING);
    const artifacts = artifactRepository();

    await expect(
      createExecutionArtifact(
        {
          content: '# Review\n\nCross-task provenance must fail.',
          createdAt: 30,
          id: 'artifact-1',
          kind: ExecutionArtifactKind.REVIEW,
          sessionId: 'session-other',
          taskId: task.id,
        },
        taskRepository(task),
        sessionRepository(exitedSession('session-other', 'task-other')),
        artifacts,
      ),
    ).rejects.toBeInstanceOf(ArtifactProvenanceError);
    expect(await artifacts.listByTaskId(task.id)).toEqual([]);
  });

  it('rejects missing Task or Session identities clearly', async () => {
    const artifacts = artifactRepository();
    const input = {
      content: '# Plan\n\nInspect first.',
      createdAt: 10,
      id: 'artifact-1',
      kind: ExecutionArtifactKind.PLAN,
      sessionId: 'missing-session',
      taskId: 'missing-task',
    } as const;

    await expect(
      createExecutionArtifact(
        input,
        taskRepository(undefined),
        sessionRepository(undefined),
        artifacts,
      ),
    ).rejects.toMatchObject({ entity: 'Task', id: 'missing-task' });

    await expect(
      createExecutionArtifact(
        input,
        taskRepository(taskInPhase(TaskPhase.PLANNING, 'missing-task')),
        sessionRepository(undefined),
        artifacts,
      ),
    ).rejects.toMatchObject({ entity: 'AgentSession', id: 'missing-session' });
  });

  it('reads one artifact and lists immutable Task history oldest first', async () => {
    const task = taskInPhase(TaskPhase.REVIEW);
    const artifacts = artifactRepository();
    const dependencies = [taskRepository(task), sessionRepository(undefined), artifacts] as const;
    await createExecutionArtifact(
      {
        content: '# Plan\n\nFirst version.',
        createdAt: 10,
        id: 'artifact-plan',
        kind: ExecutionArtifactKind.PLAN,
        taskId: task.id,
      },
      ...dependencies,
    );
    await createExecutionArtifact(
      {
        content: '# Review\n\nSecond artifact.',
        createdAt: 20,
        id: 'artifact-review',
        kind: ExecutionArtifactKind.REVIEW,
        taskId: task.id,
      },
      ...dependencies,
    );

    expect((await getExecutionArtifact('artifact-plan', artifacts)).content).toContain('First');
    expect(
      (await listTaskExecutionArtifacts(task.id, dependencies[0], artifacts)).map(({ id }) => id),
    ).toEqual(['artifact-plan', 'artifact-review']);
  });

  it('reports a missing artifact without fabricating a value', async () => {
    await expect(
      getExecutionArtifact('missing-artifact', artifactRepository()),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});

function taskInPhase(phase: Task['phase'], id = 'task-1'): Task {
  let task = createDomainTask({ id, projectId: 'project-1', title: 'Artifacts' });
  for (const next of [TaskPhase.PLANNING, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE]) {
    if (task.phase === phase) return task;
    task = transitionTask(task, next);
  }
  return task;
}

function exitedSession(id: string, taskId: string): AgentSession {
  let session = createAgentSession({ agentId: 'codex', createdAt: 10, id, taskId });
  session = recordAgentSessionEvent(session, {
    kind: 'STATUS_REPORTED',
    occurredAt: 11,
    runtimeSequence: 1,
    source: 'RUNTIME',
    status: AgentSessionStatus.WORKING,
  });
  return recordAgentSessionEvent(session, {
    exitCode: 0,
    kind: 'PROCESS_EXITED',
    occurredAt: 20,
    reason: 'PROCESS_EXIT',
    runtimeSequence: 2,
  });
}

function taskRepository(task: Task | undefined): TaskRepository {
  return {
    findById: async (id) => (task?.id === id ? task : undefined),
    insert: async () => undefined,
    update: async () => {
      throw new Error('Artifact use cases must not update Task state.');
    },
  };
}

function sessionRepository(session: AgentSession | undefined): AgentSessionRepository {
  return {
    append: async () => undefined,
    findById: async (id) => (session?.id === id ? session : undefined),
    insert: async () => undefined,
    listActive: async () => [],
    listByTaskId: async () => (session === undefined ? [] : [session]),
  };
}

function artifactRepository(): ExecutionArtifactRepository {
  const values: ExecutionArtifact[] = [];
  return {
    findById: async (id) => values.find((artifact) => artifact.id === id),
    insert: async (artifact) => {
      values.push(artifact);
    },
    listByTaskId: async (taskId) => values.filter((artifact) => artifact.taskId === taskId),
  };
}
