import {
  createTask as createDomainTask,
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
import type { ExecutionArtifactRepository, ProjectRepository, TaskRepository } from './ports';

export interface TransitionTaskInput {
  readonly taskId: string;
  readonly to: TaskPhase;
}

export interface TransitionTaskDependencies {
  readonly artifacts?: ExecutionArtifactRepository;
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
  return transitionedTask;
}
