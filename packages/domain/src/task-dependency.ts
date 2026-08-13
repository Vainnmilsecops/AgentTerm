export interface TaskDependency {
  readonly dependencyTaskId: string;
  readonly taskId: string;
}

export interface CreateTaskDependencyInput {
  readonly dependencyTaskId: string;
  readonly taskId: string;
}

export type InvalidTaskDependencyReason = 'CYCLE' | 'DUPLICATE' | 'SELF';

export class InvalidTaskDependencyError extends Error {
  public constructor(public readonly reason: InvalidTaskDependencyReason) {
    super(
      reason === 'SELF'
        ? 'A Task cannot depend on itself.'
        : reason === 'DUPLICATE'
          ? 'The Task dependency already exists.'
          : 'The Task dependency would create a cycle.',
    );
    this.name = 'InvalidTaskDependencyError';
  }
}

export function createTaskDependency(input: CreateTaskDependencyInput): TaskDependency {
  assertNonBlank(input.taskId, 'Task dependency Task id');
  assertNonBlank(input.dependencyTaskId, 'Task dependency required Task id');
  if (input.taskId === input.dependencyTaskId) {
    throw new InvalidTaskDependencyError('SELF');
  }
  return Object.freeze({ dependencyTaskId: input.dependencyTaskId, taskId: input.taskId });
}

export function validateTaskDependencyAddition(
  graph: readonly TaskDependency[],
  dependency: TaskDependency,
): TaskDependency {
  if (
    graph.some(
      (candidate) =>
        candidate.taskId === dependency.taskId &&
        candidate.dependencyTaskId === dependency.dependencyTaskId,
    )
  ) {
    throw new InvalidTaskDependencyError('DUPLICATE');
  }

  const dependenciesByTaskId = new Map<string, string[]>();
  for (const edge of graph) {
    const dependencies = dependenciesByTaskId.get(edge.taskId) ?? [];
    dependencies.push(edge.dependencyTaskId);
    dependenciesByTaskId.set(edge.taskId, dependencies);
  }
  const pending = [dependency.dependencyTaskId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const taskId = pending.pop();
    if (taskId === undefined || visited.has(taskId)) continue;
    if (taskId === dependency.taskId) {
      throw new InvalidTaskDependencyError('CYCLE');
    }
    visited.add(taskId);
    pending.push(...(dependenciesByTaskId.get(taskId) ?? []));
  }
  return dependency;
}

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
