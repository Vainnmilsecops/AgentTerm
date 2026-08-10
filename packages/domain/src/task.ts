import { TaskPhase, type TaskPhase as TaskPhaseValue } from './task-phase';

const nextTaskPhase: Readonly<Record<TaskPhaseValue, TaskPhaseValue | null>> = {
  [TaskPhase.BACKLOG]: TaskPhase.PLANNING,
  [TaskPhase.PLANNING]: TaskPhase.RUNNING,
  [TaskPhase.RUNNING]: TaskPhase.REVIEW,
  [TaskPhase.REVIEW]: TaskPhase.DONE,
  [TaskPhase.DONE]: null,
};

export interface Task {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly phase: TaskPhaseValue;
}

export interface CreateTaskInput {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

export class InvalidTaskPhaseTransitionError extends Error {
  public readonly from: TaskPhaseValue;
  public readonly to: TaskPhaseValue;

  public constructor(from: TaskPhaseValue, to: TaskPhaseValue) {
    super(`Cannot transition a task from ${from} to ${to}.`);
    this.name = 'InvalidTaskPhaseTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function createTask(input: CreateTaskInput): Task {
  assertNonBlank(input.id, 'Task id');
  assertNonBlank(input.projectId, 'Task project id');
  assertNonBlank(input.title, 'Task title');

  return Object.freeze({ ...input, phase: TaskPhase.BACKLOG });
}

export function transitionTask(task: Task, to: TaskPhaseValue): Task {
  if (nextTaskPhase[task.phase] !== to) {
    throw new InvalidTaskPhaseTransitionError(task.phase, to);
  }

  return Object.freeze({ ...task, phase: to });
}

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
