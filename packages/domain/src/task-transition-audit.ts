import { TaskPhase, type TaskPhase as TaskPhaseValue } from './task-phase';

/**
 * Identifies the actor that triggered a Task phase transition.
 *
 * The Domain layer is intentionally narrow: only triggers that the
 * Application layer actually emits today are modeled. Adding a new trigger
 * means adding a Domain reason here, a port write in Application, and a
 * SQLite mapping in Infrastructure.
 */
export const TaskTransitionTrigger = Object.freeze({
  MANUAL: 'manual',
  RESEARCH_AUTO_ADVANCE: 'research-auto-advance',
} as const);

export type TaskTransitionTrigger =
  (typeof TaskTransitionTrigger)[keyof typeof TaskTransitionTrigger];

/**
 * Immutable, append-only record of a Task phase transition. Persisted by the
 * Application layer for audit and reconciliation, never edited after insert.
 */
export interface TaskTransitionAudit {
  readonly artifactId: string | undefined;
  readonly createdAt: number;
  readonly fromPhase: TaskPhaseValue;
  readonly id: string;
  readonly taskId: string;
  readonly toPhase: TaskPhaseValue;
  readonly trigger: TaskTransitionTrigger;
}

export interface CreateTaskTransitionAuditInput {
  readonly artifactId?: string;
  readonly createdAt: number;
  readonly fromPhase: TaskPhaseValue;
  readonly id: string;
  readonly taskId: string;
  readonly toPhase: TaskPhaseValue;
  readonly trigger: TaskTransitionTrigger;
}

export function createTaskTransitionAudit(
  input: CreateTaskTransitionAuditInput,
): TaskTransitionAudit {
  assertNonBlank(input.id, 'Task Transition Audit id');
  assertNonBlank(input.taskId, 'Task Transition Audit Task id');
  assertTimestamp(input.createdAt);
  assertValidPhase(input.fromPhase, 'fromPhase');
  assertValidPhase(input.toPhase, 'toPhase');
  if (input.toPhase === input.fromPhase) {
    throw new TypeError(
      'Task Transition Audit must change phase; fromPhase and toPhase are equal.',
    );
  }
  if (input.artifactId !== undefined) {
    assertNonBlank(input.artifactId, 'Task Transition Audit artifact id');
  }
  if (
    input.trigger !== TaskTransitionTrigger.MANUAL &&
    input.trigger !== TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE
  ) {
    throw new TypeError(`Task Transition Audit trigger '${input.trigger}' is not supported.`);
  }
  // RESEARCH_AUTO_ADVANCE is only valid for BACKLOG -> PLANNING transitions.
  if (input.trigger === TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE) {
    if (input.fromPhase !== TaskPhase.BACKLOG || input.toPhase !== TaskPhase.PLANNING) {
      throw new TypeError(
        'Task Transition Audit RESEARCH_AUTO_ADVANCE trigger only applies to BACKLOG -> PLANNING.',
      );
    }
    if (input.artifactId === undefined) {
      throw new TypeError(
        'Task Transition Audit RESEARCH_AUTO_ADVANCE trigger requires an artifact id.',
      );
    }
  }

  return Object.freeze({
    artifactId: input.artifactId,
    createdAt: input.createdAt,
    fromPhase: input.fromPhase,
    id: input.id,
    taskId: input.taskId,
    toPhase: input.toPhase,
    trigger: input.trigger,
  });
}

function assertValidPhase(phase: unknown, field: string): void {
  const valid = new Set<string>(Object.values(TaskPhase));
  if (typeof phase !== 'string' || !valid.has(phase)) {
    throw new TypeError(`Task Transition Audit ${field} must be a valid TaskPhase.`);
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Task Transition Audit creation timestamp must be a nonnegative integer.');
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
