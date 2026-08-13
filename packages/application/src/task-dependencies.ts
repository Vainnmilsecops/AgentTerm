import {
  TaskPhase,
  createTaskDependency,
  validateTaskDependencyAddition,
  type CreateTaskDependencyInput,
  type Task,
  type TaskDependency,
} from '@agentterm/domain';

import { EntityNotFoundError, TaskDependencyProjectMismatchError } from './errors';
import type { TaskDependencyRepository, TaskRepository } from './ports';

export interface ListTaskDependenciesInput {
  readonly taskId: string;
}

export interface TaskDependencyStatus {
  readonly dependency: Task;
  readonly satisfied: boolean;
}

export interface TaskDependencyState {
  readonly blocked: boolean;
  readonly dependencies: readonly TaskDependencyStatus[];
}

export async function addTaskDependency(
  input: CreateTaskDependencyInput,
  tasks: TaskRepository,
  dependencies: TaskDependencyRepository,
): Promise<TaskDependency> {
  const dependency = createTaskDependency(input);
  const [task, requiredTask] = await requireDependencyTasks(dependency, tasks);
  assertSameProject(task, requiredTask);
  const graph = await dependencies.listByProjectId(task.projectId);
  validateTaskDependencyAddition(graph, dependency);
  await dependencies.add(dependency);
  return dependency;
}

export async function removeTaskDependency(
  input: CreateTaskDependencyInput,
  tasks: TaskRepository,
  dependencies: TaskDependencyRepository,
): Promise<boolean> {
  const dependency = createTaskDependency(input);
  const [task, requiredTask] = await requireDependencyTasks(dependency, tasks);
  assertSameProject(task, requiredTask);
  return dependencies.remove(dependency);
}

export async function listTaskDependencies(
  input: ListTaskDependenciesInput,
  tasks: TaskRepository,
  dependencies: TaskDependencyRepository,
): Promise<readonly TaskDependency[]> {
  await requireTask(input.taskId, tasks);
  return Object.freeze([...(await dependencies.listByTaskId(input.taskId))]);
}

export async function readTaskDependencyState(
  taskId: string,
  tasks: TaskRepository,
  dependencies: TaskDependencyRepository,
): Promise<TaskDependencyState> {
  const task = await requireTask(taskId, tasks);
  const edges = await dependencies.listByTaskId(taskId);
  const statuses = await Promise.all(
    edges.map(async ({ dependencyTaskId }): Promise<TaskDependencyStatus> => {
      const dependency = await requireTask(dependencyTaskId, tasks);
      assertSameProject(task, dependency);
      return Object.freeze({ dependency, satisfied: dependency.phase === TaskPhase.DONE });
    }),
  );
  return Object.freeze({
    blocked: statuses.some(({ satisfied }) => !satisfied),
    dependencies: Object.freeze(statuses),
  });
}

async function requireDependencyTasks(
  dependency: TaskDependency,
  tasks: TaskRepository,
): Promise<readonly [Task, Task]> {
  return Promise.all([
    requireTask(dependency.taskId, tasks),
    requireTask(dependency.dependencyTaskId, tasks),
  ]);
}

async function requireTask(taskId: string, tasks: TaskRepository): Promise<Task> {
  const task = await tasks.findById(taskId);
  if (task === undefined) throw new EntityNotFoundError('Task', taskId);
  return task;
}

function assertSameProject(task: Task, dependency: Task): void {
  if (task.projectId !== dependency.projectId) {
    throw new TaskDependencyProjectMismatchError(task.id, dependency.id);
  }
}
