import { TaskPhase, type TaskPhase as TaskPhaseValue } from './task-phase';

const allowedNextTaskPhases: Readonly<Record<TaskPhaseValue, readonly TaskPhaseValue[]>> = {
  [TaskPhase.BACKLOG]: [TaskPhase.PLANNING],
  [TaskPhase.PLANNING]: [TaskPhase.RUNNING],
  [TaskPhase.RUNNING]: [TaskPhase.REVIEW],
  [TaskPhase.REVIEW]: [TaskPhase.RUNNING, TaskPhase.DONE],
  [TaskPhase.DONE]: [],
};

export const TaskBriefLimits = Object.freeze({ CONTENT: 16_384 });

export interface Task {
  readonly brief?: string;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly phase: TaskPhaseValue;
}

export interface CreateTaskInput {
  readonly brief?: string;
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
  if (input.brief !== undefined) {
    assertTaskBrief(input.brief);
  }

  return Object.freeze({ ...input, phase: TaskPhase.BACKLOG });
}

function assertTaskBrief(value: string): void {
  if (
    value.trim().length === 0 ||
    value.length > TaskBriefLimits.CONTENT ||
    hasForbiddenTaskBriefControl(value)
  ) {
    throw new TypeError('Task Brief is invalid.');
  }
}

function hasForbiddenTaskBriefControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x7f ||
      (codePoint !== undefined &&
        codePoint <= 0x1f &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a &&
        codePoint !== 0x0d)
    ) {
      return true;
    }
  }
  return false;
}

export function transitionTask(task: Task, to: TaskPhaseValue): Task {
  if (!allowedNextTaskPhases[task.phase].includes(to)) {
    throw new InvalidTaskPhaseTransitionError(task.phase, to);
  }

  return Object.freeze({ ...task, phase: to });
}

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
