import { describe, expect, it } from 'vitest';

import {
  createProject as createDomainProject,
  createTask as createDomainTask,
  ExecutionArtifactKind,
  createExecutionArtifact as createDomainArtifact,
  transitionTask as transitionDomainTask,
  TaskPhase,
  type ExecutionArtifact,
  type Project,
  type Task,
} from '@agentterm/domain';

import { createTask, transitionTask, type ExecutionArtifactRepository, type ProjectRepository, type TaskRepository } from './index';

class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  public constructor(projects: readonly Project[] = []) {
    for (const project of projects) {
      this.projects.set(project.id, project);
    }
  }

  public async findById(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  public async insert(project: Project): Promise<void> {
    if (this.projects.has(project.id)) {
      throw new Error(`Project ${project.id} already exists in the fake repository.`);
    }

    this.projects.set(project.id, project);
  }
}

class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  public async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async insert(task: Task): Promise<void> {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task ${task.id} already exists in the fake repository.`);
    }

    this.tasks.set(task.id, task);
  }

  public async update(task: Task, expectedPhase: Task['phase']): Promise<void> {
    if (this.tasks.get(task.id)?.phase !== expectedPhase) {
      throw new Error(`Task ${task.id} is missing from the fake repository.`);
    }

    this.tasks.set(task.id, task);
  }
}

class InMemoryArtifactRepository implements ExecutionArtifactRepository {
  public constructor(private readonly values: readonly ExecutionArtifact[] = []) {}
  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    return this.values.find((artifact) => artifact.id === id);
  }
  public async findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined> {
    const matches = this.values.filter(
      (artifact) => artifact.taskId === taskId && artifact.kind === kind,
    );
    if (matches.length === 0) return undefined;
    return matches.reduce((latest, candidate) =>
      candidate.createdAt > latest.createdAt ? candidate : latest,
    );
  }
  public async insert(artifact: ExecutionArtifact): Promise<void> {
    throw new Error('not used');
  }
  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    return this.values.filter((artifact) => artifact.taskId === taskId);
  }
  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly ExecutionArtifact[]> {
    return this.values.filter((artifact) => artifact.taskId === taskId).slice(-limit);
  }
  public async readReviewEvidenceByTaskId() {
    return { evidence: [], totalCount: 0 };
  }
}

function researchArtifact(taskId: string, createdAt: number): ExecutionArtifact {
  return createDomainArtifact({
    content: '# Research\n\nFindings go here.',
    createdAt,
    id: `artifact-${taskId}-${createdAt}`,
    kind: ExecutionArtifactKind.RESEARCH,
    taskId,
  });
}

const project = createDomainProject({ id: 'project-1', name: 'AgentTerm' });
const validTaskInput = {
  id: 'task-1',
  projectId: project.id,
  title: 'Build application use cases',
};

describe('createTask', () => {
  it('creates a BACKLOG task for an existing project and persists it', async () => {
    const projects = new InMemoryProjectRepository([project]);
    const tasks = new InMemoryTaskRepository();

    const task = await createTask(validTaskInput, projects, tasks);

    expect(task).toEqual({ ...validTaskInput, phase: 'BACKLOG' });
    await expect(tasks.findById('task-1')).resolves.toEqual(task);
  });

  it('rejects a task whose project does not exist', async () => {
    const projects = new InMemoryProjectRepository();
    const tasks = new InMemoryTaskRepository();

    const result = createTask(validTaskInput, projects, tasks);

    await expect(result).rejects.toMatchObject({
      name: 'EntityNotFoundError',
      entity: 'Project',
      id: 'project-1',
    });
    await expect(tasks.findById('task-1')).resolves.toBeUndefined();
  });

  it('rejects a duplicate task id without replacing the existing task', async () => {
    const projects = new InMemoryProjectRepository([project]);
    const tasks = new InMemoryTaskRepository();
    await createTask(validTaskInput, projects, tasks);

    const duplicate = createTask({ ...validTaskInput, title: 'Replacement task' }, projects, tasks);

    await expect(duplicate).rejects.toMatchObject({
      name: 'EntityAlreadyExistsError',
      entity: 'Task',
      id: 'task-1',
    });
    await expect(tasks.findById('task-1')).resolves.toEqual({
      ...validTaskInput,
      phase: 'BACKLOG',
    });
  });
});

describe('transitionTask', () => {
  it('loads a task, applies the Domain transition, and persists the result', async () => {
    const projects = new InMemoryProjectRepository([project]);
    const tasks = new InMemoryTaskRepository();
    await createTask(validTaskInput, projects, tasks);

    const planning = await transitionTask({ taskId: 'task-1', to: TaskPhase.PLANNING }, tasks);

    expect(planning.phase).toBe(TaskPhase.PLANNING);
    await expect(tasks.findById('task-1')).resolves.toEqual(planning);
  });

  it('rejects a transition when the task does not exist', async () => {
    const tasks = new InMemoryTaskRepository();

    const result = transitionTask({ taskId: 'missing-task', to: TaskPhase.PLANNING }, tasks);

    await expect(result).rejects.toMatchObject({
      name: 'EntityNotFoundError',
      entity: 'Task',
      id: 'missing-task',
    });
  });

  it('preserves persisted state when the Domain rejects a transition', async () => {
    const projects = new InMemoryProjectRepository([project]);
    const tasks = new InMemoryTaskRepository();
    const backlog = await createTask(validTaskInput, projects, tasks);

    const result = transitionTask({ taskId: 'task-1', to: TaskPhase.RUNNING }, tasks);

    await expect(result).rejects.toMatchObject({
      name: 'InvalidTaskPhaseTransitionError',
      from: TaskPhase.BACKLOG,
      to: TaskPhase.RUNNING,
    });
    await expect(tasks.findById('task-1')).resolves.toEqual(backlog);
  });

  it('requires the structured Review Flow for transitions into or out of REVIEW', async () => {
    const tasks = new InMemoryTaskRepository();
    const running = transitionDomainTask(
      transitionDomainTask(createDomainTask(validTaskInput), TaskPhase.PLANNING),
      TaskPhase.RUNNING,
    );
    await tasks.insert(running);

    await expect(
      transitionTask({ taskId: running.id, to: TaskPhase.REVIEW }, tasks),
    ).rejects.toMatchObject({
      name: 'TaskReviewFlowRequiredError',
      from: TaskPhase.RUNNING,
      to: TaskPhase.REVIEW,
    });
    await expect(tasks.findById(running.id)).resolves.toEqual(running);

    const review = transitionDomainTask(running, TaskPhase.REVIEW);
    await tasks.update(review, running.phase);
    await expect(
      transitionTask({ taskId: review.id, to: TaskPhase.DONE }, tasks),
    ).rejects.toMatchObject({
      name: 'TaskReviewFlowRequiredError',
      from: TaskPhase.REVIEW,
      to: TaskPhase.DONE,
    });
    await expect(tasks.findById(review.id)).resolves.toEqual(review);
  });

  it('requires Accept Plan for the PLANNING to RUNNING transition', async () => {
    const tasks = new InMemoryTaskRepository();
    const planning = transitionDomainTask(createDomainTask(validTaskInput), TaskPhase.PLANNING);
    await tasks.insert(planning);

    await expect(
      transitionTask({ taskId: planning.id, to: TaskPhase.RUNNING }, tasks),
    ).rejects.toMatchObject({
      from: TaskPhase.PLANNING,
      name: 'TaskPlanningFlowRequiredError',
      to: TaskPhase.RUNNING,
    });
    await expect(tasks.findById(planning.id)).resolves.toEqual(planning);
  });

  it('blocks BACKLOG to PLANNING when no Research artifact exists', async () => {
    const projects = new InMemoryProjectRepository([project]);
    const tasks = new InMemoryTaskRepository();
    await createTask(validTaskInput, projects, tasks);
    const artifacts = new InMemoryArtifactRepository();

    await expect(
      transitionTask({ taskId: 'task-1', to: TaskPhase.PLANNING }, tasks, artifacts),
    ).rejects.toMatchObject({ name: 'TaskResearchPhaseError', reason: 'ARTIFACT_MISSING' });
    await expect(tasks.findById('task-1')).resolves.toMatchObject({ phase: TaskPhase.BACKLOG });
  });

  it('admits BACKLOG to PLANNING when a valid Research artifact exists', async () => {
    const projects = new InMemoryProjectRepository([project]);
    const tasks = new InMemoryTaskRepository();
    await createTask(validTaskInput, projects, tasks);
    const artifacts = new InMemoryArtifactRepository([researchArtifact('task-1', 7)]);

    const planning = await transitionTask(
      { taskId: 'task-1', to: TaskPhase.PLANNING },
      tasks,
      artifacts,
    );

    expect(planning.phase).toBe(TaskPhase.PLANNING);
    await expect(tasks.findById('task-1')).resolves.toEqual(planning);
  });
});
