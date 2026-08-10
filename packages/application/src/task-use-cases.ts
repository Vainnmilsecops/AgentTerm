import {
  createTask as createDomainTask,
  transitionTask as transitionDomainTask,
  type CreateTaskInput,
  type Task,
  type TaskPhase,
} from '@agentterm/domain';

import { EntityAlreadyExistsError, EntityNotFoundError } from './errors';
import type { ProjectRepository, TaskRepository } from './ports';

export interface TransitionTaskInput {
  readonly taskId: string;
  readonly to: TaskPhase;
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
): Promise<Task> {
  const task = await tasks.findById(input.taskId);

  if (task === undefined) {
    throw new EntityNotFoundError('Task', input.taskId);
  }

  const transitionedTask = transitionDomainTask(task, input.to);
  await tasks.update(transitionedTask);
  return transitionedTask;
}
