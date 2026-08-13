import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionStatus,
  ExecutionArtifactKind,
  TaskPhase,
  createAgentSession,
  createExecutionArtifact,
  createTask,
  recordAgentSessionEvent,
  transitionTask,
  type AgentSession,
  type ExecutionArtifact,
  type Task,
} from '@agentterm/domain';

import {
  TaskPlanReadinessError,
  acceptTaskPlan,
  createTaskPlan,
  type AgentSessionRepository,
  type ExecutionArtifactRepository,
  type TaskPlanningRepository,
  type TaskRepository,
} from './index';

describe('planning artifact workflow', () => {
  it('persists a structured session-produced Plan without changing PLANNING', async () => {
    const task = taskInPhase(TaskPhase.PLANNING);
    const session = exitedSession('session-plan', task.id);
    const tasks = new MemoryTaskRepository(task);
    const sessions = new MemorySessionRepository([session]);
    const artifacts = new MemoryArtifactRepository(tasks);

    const plan = await createTaskPlan(
      {
        content: '# Plan\n\n1. Inspect the current flow.\n2. Implement the smallest change.',
        createdAt: 30,
        id: 'plan-1',
        sessionId: session.id,
        taskId: task.id,
      },
      { artifacts, sessions, tasks },
    );

    expect(plan).toMatchObject({
      canonicalName: 'planning/plan.md',
      id: 'plan-1',
      kind: ExecutionArtifactKind.PLAN,
      phase: TaskPhase.PLANNING,
      sessionId: session.id,
      validation: 'VALID',
    });
    expect(await artifacts.listByTaskId(task.id)).toEqual([plan]);
    expect(await tasks.findById(task.id)).toEqual(task);
  });

  it('appends revised Plans instead of replacing earlier artifacts', async () => {
    const task = taskInPhase(TaskPhase.PLANNING);
    const firstSession = exitedSession('session-plan-1', task.id, 10);
    const secondSession = exitedSession('session-plan-2', task.id, 20);
    const tasks = new MemoryTaskRepository(task);
    const sessions = new MemorySessionRepository([firstSession, secondSession]);
    const artifacts = new MemoryArtifactRepository(tasks);

    await createTaskPlan(
      {
        content: '# Plan\n\nInitial approach.',
        createdAt: 30,
        id: 'plan-1',
        sessionId: firstSession.id,
        taskId: task.id,
      },
      { artifacts, sessions, tasks },
    );
    await createTaskPlan(
      {
        content: '# Plan\n\nRevised approach with preserved history.',
        createdAt: 40,
        id: 'plan-2',
        sessionId: secondSession.id,
        taskId: task.id,
      },
      { artifacts, sessions, tasks },
    );

    await expect(artifacts.listByTaskId(task.id)).resolves.toMatchObject([
      { id: 'plan-1', sessionId: 'session-plan-1' },
      { id: 'plan-2', sessionId: 'session-plan-2' },
    ]);
  });

  it('rejects Plan persistence outside PLANNING or without same-Task Session provenance', async () => {
    const running = taskInPhase(TaskPhase.RUNNING);
    const planning = taskInPhase(TaskPhase.PLANNING);
    const otherSession = exitedSession('session-other', 'task-other');

    await expect(
      createTaskPlan(
        {
          content: '# Plan\n\nToo late.',
          createdAt: 30,
          id: 'plan-running',
          sessionId: exitedSession('session-running', running.id).id,
          taskId: running.id,
        },
        {
          artifacts: new MemoryArtifactRepository(new MemoryTaskRepository(running)),
          sessions: new MemorySessionRepository([exitedSession('session-running', running.id)]),
          tasks: new MemoryTaskRepository(running),
        },
      ),
    ).rejects.toMatchObject({ name: 'TaskPlanningPhaseError', phase: TaskPhase.RUNNING });

    await expect(
      createTaskPlan(
        {
          content: '# Plan\n\nWrong provenance.',
          createdAt: 30,
          id: 'plan-other',
          sessionId: otherSession.id,
          taskId: planning.id,
        },
        {
          artifacts: new MemoryArtifactRepository(new MemoryTaskRepository(planning)),
          sessions: new MemorySessionRepository([otherSession]),
          tasks: new MemoryTaskRepository(planning),
        },
      ),
    ).rejects.toMatchObject({ name: 'ArtifactProvenanceError' });
  });
});

describe('acceptTaskPlan', () => {
  it('moves PLANNING to RUNNING only for explicit acceptance of the latest persisted Plan', async () => {
    const fixture = planningFixture();
    const plan = await fixture.createPlan('plan-1', fixture.session.id, 30, 'Ready to execute.');

    const accepted = await acceptTaskPlan(
      { planId: plan.id, taskId: fixture.task.id },
      fixture.dependencies,
    );

    expect(accepted).toMatchObject({ id: fixture.task.id, phase: TaskPhase.RUNNING });
    expect(await fixture.tasks.findById(fixture.task.id)).toEqual(accepted);
    expect(fixture.planning.acceptPlan).toHaveBeenCalledWith(plan, accepted, [
      { historySequence: 2, id: fixture.session.id },
    ]);
    expect(await fixture.artifacts.listByTaskId(fixture.task.id)).toEqual([plan]);
  });

  it('rejects acceptance while an AgentSession may still write', async () => {
    const task = taskInPhase(TaskPhase.PLANNING);
    const active = createAgentSession({
      agentId: 'codex',
      createdAt: 10,
      id: 'session-active',
      taskId: task.id,
    });
    const tasks = new MemoryTaskRepository(task);
    const sessions = new MemorySessionRepository([active]);
    const artifacts = new MemoryArtifactRepository(tasks);
    const plan = createExecutionArtifact({
      content: '# Plan\n\nDo not accept while the writer is active.',
      createdAt: 20,
      id: 'plan-active',
      kind: ExecutionArtifactKind.PLAN,
      sessionId: active.id,
      taskId: task.id,
    });
    await artifacts.insert(plan, TaskPhase.PLANNING);
    const planning = planningRepository(tasks);

    await expect(
      acceptTaskPlan(
        { planId: plan.id, taskId: task.id },
        { artifacts, planning, sessions, tasks },
      ),
    ).rejects.toEqual(new TaskPlanReadinessError('ACTIVE_SESSION', task.id, plan.id));
    expect(planning.acceptPlan).not.toHaveBeenCalled();
    expect((await tasks.findById(task.id))?.phase).toBe(TaskPhase.PLANNING);
  });

  it('rejects a stale Plan selection after a revision and preserves PLANNING', async () => {
    const fixture = planningFixture();
    const first = await fixture.createPlan('plan-1', fixture.session.id, 30, 'Initial.');
    const secondSession = exitedSession('session-plan-2', fixture.task.id, 40);
    fixture.sessions.values.push(secondSession);
    await fixture.createPlan('plan-2', secondSession.id, 50, 'Revised.');

    await expect(
      acceptTaskPlan({ planId: first.id, taskId: fixture.task.id }, fixture.dependencies),
    ).rejects.toEqual(new TaskPlanReadinessError('PLAN_NOT_LATEST', fixture.task.id, first.id));
    expect(fixture.planning.acceptPlan).not.toHaveBeenCalled();
    expect((await fixture.tasks.findById(fixture.task.id))?.phase).toBe(TaskPhase.PLANNING);
  });

  it.each([TaskPhase.BACKLOG, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE])(
    'rejects Accept Plan from Task phase %s',
    async (phase) => {
      const task = taskInPhase(phase);
      const tasks = new MemoryTaskRepository(task);

      await expect(
        acceptTaskPlan(
          { planId: 'plan-1', taskId: task.id },
          {
            artifacts: new MemoryArtifactRepository(tasks),
            planning: planningRepository(tasks),
            sessions: new MemorySessionRepository([]),
            tasks,
          },
        ),
      ).rejects.toMatchObject({ name: 'TaskPlanningPhaseError', phase });
    },
  );
});

function planningFixture() {
  const task = taskInPhase(TaskPhase.PLANNING);
  const session = exitedSession('session-plan', task.id);
  const tasks = new MemoryTaskRepository(task);
  const sessions = new MemorySessionRepository([session]);
  const artifacts = new MemoryArtifactRepository(tasks);
  const planning = planningRepository(tasks);
  const dependencies = { artifacts, planning, sessions, tasks };
  return {
    artifacts,
    async createPlan(id: string, sessionId: string, createdAt: number, body: string) {
      return createTaskPlan(
        { content: `# Plan\n\n${body}`, createdAt, id, sessionId, taskId: task.id },
        dependencies,
      );
    },
    dependencies,
    planning,
    session,
    sessions,
    task,
    tasks,
  };
}

class MemoryTaskRepository implements TaskRepository {
  public constructor(public value: Task) {}
  public async findById(id: string): Promise<Task | undefined> {
    return this.value.id === id ? this.value : undefined;
  }
  public async insert(task: Task): Promise<void> {
    this.value = task;
  }
  public async update(task: Task, expectedPhase: Task['phase']): Promise<void> {
    if (this.value.phase !== expectedPhase) throw new Error('stale Task');
    this.value = task;
  }
}

class MemorySessionRepository implements AgentSessionRepository {
  public constructor(public readonly values: AgentSession[]) {}
  public async append(): Promise<void> {}
  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.values.find((session) => session.id === id);
  }
  public async insert(session: AgentSession): Promise<void> {
    this.values.push(session);
  }
  public async listActive(): Promise<readonly AgentSession[]> {
    return this.values.filter((session) => !isTerminal(session));
  }
  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return this.values.filter((session) => session.taskId === taskId);
  }
}

class MemoryArtifactRepository implements ExecutionArtifactRepository {
  private readonly values: ExecutionArtifact[] = [];
  public constructor(private readonly tasks: MemoryTaskRepository) {}
  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    return this.values.find((artifact) => artifact.id === id);
  }
  public async findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined> {
    return this.values
      .filter((artifact) => artifact.taskId === taskId && artifact.kind === kind)
      .at(-1);
  }
  public async insert(
    artifact: ExecutionArtifact,
    expectedTaskPhase?: Task['phase'],
  ): Promise<void> {
    if (expectedTaskPhase !== undefined && this.tasks.value.phase !== expectedTaskPhase) {
      throw new Error('stale Task phase');
    }
    if (this.values.some(({ id }) => id === artifact.id)) throw new Error('duplicate artifact');
    this.values.push(artifact);
  }
  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    return this.values.filter((artifact) => artifact.taskId === taskId);
  }
  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly ExecutionArtifact[]> {
    return (await this.listByTaskId(taskId)).slice(-limit);
  }
  public async readReviewEvidenceByTaskId() {
    return { evidence: [], totalCount: this.values.length };
  }
}

function planningRepository(tasks: MemoryTaskRepository): TaskPlanningRepository & {
  acceptPlan: ReturnType<typeof vi.fn<TaskPlanningRepository['acceptPlan']>>;
} {
  const acceptPlan = vi.fn<TaskPlanningRepository['acceptPlan']>(async (_plan, nextTask) => {
    await tasks.update(nextTask, TaskPhase.PLANNING);
  });
  return { acceptPlan };
}

function taskInPhase(phase: Task['phase']): Task {
  let task = createTask({ id: 'task-1', projectId: 'project-1', title: 'Planning workflow' });
  for (const next of [TaskPhase.PLANNING, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE]) {
    if (task.phase === phase) return task;
    task = transitionTask(task, next);
  }
  return task;
}

function exitedSession(id: string, taskId: string, createdAt = 10): AgentSession {
  const starting = createAgentSession({ agentId: 'codex', createdAt, id, taskId });
  return recordAgentSessionEvent(starting, {
    exitCode: 0,
    kind: 'PROCESS_EXITED',
    occurredAt: createdAt + 1,
    reason: 'PROCESS_EXIT',
    runtimeSequence: 1,
  });
}

function isTerminal(session: AgentSession): boolean {
  return (
    session.status === AgentSessionStatus.EXITED || session.status === AgentSessionStatus.FAILED
  );
}
