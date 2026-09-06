import {
  createTask as createDomainTask,
  createTaskTransitionAudit,
  TaskTransitionTrigger,
  transitionTask as transitionDomainTask,
  type CreateTaskInput,
  type Task,
  type TaskPhase,
} from '@agentterm/domain';

import { assertCanEnterPlanning } from './can-enter-planning';
import {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  TaskPlanningFlowRequiredError,
  TaskReviewFlowRequiredError,
} from './errors';
import type {
  ExecutionArtifactRepository,
  ProjectRepository,
  TaskRepository,
  TaskTransitionLog,
} from './ports';

export interface TransitionTaskInput {
  readonly artifactId?: string;
  readonly taskId: string;
  readonly to: TaskPhase;
  readonly trigger?: TaskTransitionTrigger;
}

export interface TransitionTaskDependencies {
  readonly artifacts?: ExecutionArtifactRepository;
  readonly clock?: () => number;
  readonly taskTransitions?: TaskTransitionLog;
  readonly tasks: TaskRepository;
}

export async function createTask(
  input: CreateTaskInput,
  projects: ProjectRepository,
  tasks: TaskRepository,
): Promise<Task> {
  const task = createDomainTask(input);

  if ((await projects.findById(task.projectId)) === undefined) {
    throw new EntityNotFoundError('Project', task.projectId);
  }

  if ((await tasks.findById(task.id)) !== undefined) {
    throw new EntityAlreadyExistsError('Task', task.id);
  }

  await tasks.insert(task);
  return task;
}

export async function transitionTask(
  input: TransitionTaskInput,
  tasks: TaskRepository,
  artifacts?: ExecutionArtifactRepository,
  taskTransitions?: TaskTransitionLog,
  clock?: () => number,
): Promise<Task> {
  const task = await tasks.findById(input.taskId);

  if (task === undefined) {
    throw new EntityNotFoundError('Task', input.taskId);
  }

  if (
    (task.phase === 'PLANNING' && input.to === 'RUNNING') ||
    (task.phase === 'RUNNING' && input.to === 'REVIEW') ||
    (task.phase === 'REVIEW' && (input.to === 'RUNNING' || input.to === 'DONE'))
  ) {
    if (task.phase === 'PLANNING') {
      throw new TaskPlanningFlowRequiredError(task.phase, input.to);
    }
    throw new TaskReviewFlowRequiredError(task.phase, input.to);
  }

  if (task.phase === 'BACKLOG' && input.to === 'PLANNING' && artifacts !== undefined) {
    await assertCanEnterPlanning({
      artifacts,
      taskId: input.taskId,
      taskPhase: task.phase,
    });
  }

  const transitionedTask = transitionDomainTask(task, input.to);
  await tasks.update(transitionedTask, task.phase);

  if (taskTransitions !== undefined) {
    const createdAt = clock?.() ?? Date.now();
    await taskTransitions.append(
      createTaskTransitionAudit({
        ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
        createdAt,
        fromPhase: task.phase,
        id: `audit-${task.id}-${task.phase}->${input.to}-${createdAt}`,
        taskId: task.id,
        toPhase: input.to,
        trigger: input.trigger ?? TaskTransitionTrigger.MANUAL,
      }),
    );
  }

  return transitionedTask;
}
