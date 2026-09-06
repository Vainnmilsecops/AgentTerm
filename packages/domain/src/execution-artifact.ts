import { TaskPhase, type TaskPhase as TaskPhaseValue } from './task-phase';

export const ExecutionArtifactKind = Object.freeze({
  BRAINSTORM: 'brainstorm',
  EXECUTION_SUMMARY: 'execution-summary',
  PLAN: 'plan',
  RESEARCH: 'research',
  REVIEW: 'review',
  SWEEP: 'sweep',
} as const);

export type ExecutionArtifactKind =
  (typeof ExecutionArtifactKind)[keyof typeof ExecutionArtifactKind];

/**
 * Artifact kinds whose `phase` is resolved dynamically from the Task at
 * capture-time rather than from a static contract. Brainstorm and Sweep
 * notes are mid-session captures; the phase they belong to is the phase
 * the Task was in when the user pressed the slash command.
 */
export const dynamicPhaseArtifactKinds = Object.freeze([
  ExecutionArtifactKind.BRAINSTORM,
  ExecutionArtifactKind.SWEEP,
] as const);

export type DynamicPhaseArtifactKind = (typeof dynamicPhaseArtifactKinds)[number];

export function isDynamicPhaseArtifactKind(
  kind: ExecutionArtifactKind,
): kind is DynamicPhaseArtifactKind {
  return (dynamicPhaseArtifactKinds as readonly ExecutionArtifactKind[]).includes(kind);
}

export interface ExecutionArtifact {
  readonly canonicalName:
    | 'planning/plan.md'
    | 'research/research.md'
    | 'review/review.md'
    | 'running/execution-summary.md'
    | `brainstorm/${string}.md`
    | `sweep/${string}.md`;
  readonly content: string;
  readonly createdAt: number;
  readonly format: 'markdown';
  readonly id: string;
  readonly kind: ExecutionArtifactKind;
  readonly phase: TaskPhaseValue;
  readonly schemaVersion: 1;
  readonly sessionId: string | undefined;
  readonly taskId: string;
  readonly validation: 'VALID';
}

export interface CreateExecutionArtifactInput {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly kind: ExecutionArtifactKind;
  /**
   * Required for dynamic-phase kinds (`BRAINSTORM`, `SWEEP`): the capture
   * has no meaning without a session to attribute it to.
   */
  readonly sessionId?: string;
  readonly taskId: string;
  /**
   * Required for dynamic-phase kinds. For static kinds it must match the
   * contract phase and is otherwise ignored.
   */
  readonly phase?: TaskPhaseValue;
}

interface ExecutionArtifactContract {
  readonly canonicalNameResolver: (fileStem: string) => ExecutionArtifact['canonicalName'];
  readonly heading: string;
  readonly phase: TaskPhaseValue;
}

const maximumContentLength = 1_048_576;

const contracts: Readonly<Record<ExecutionArtifactKind, ExecutionArtifactContract>> = {
  [ExecutionArtifactKind.BRAINSTORM]: {
    canonicalNameResolver: (fileStem) => `brainstorm/${fileStem}.md`,
    heading: '# Brainstorm',
    phase: TaskPhase.BACKLOG,
  },
  [ExecutionArtifactKind.EXECUTION_SUMMARY]: {
    canonicalNameResolver: () => 'running/execution-summary.md',
    heading: '# Execution Summary',
    phase: TaskPhase.RUNNING,
  },
  [ExecutionArtifactKind.PLAN]: {
    canonicalNameResolver: () => 'planning/plan.md',
    heading: '# Plan',
    phase: TaskPhase.PLANNING,
  },
  [ExecutionArtifactKind.RESEARCH]: {
    canonicalNameResolver: () => 'research/research.md',
    heading: '# Research',
    phase: TaskPhase.BACKLOG,
  },
  [ExecutionArtifactKind.REVIEW]: {
    canonicalNameResolver: () => 'review/review.md',
    heading: '# Review',
    phase: TaskPhase.REVIEW,
  },
  [ExecutionArtifactKind.SWEEP]: {
    canonicalNameResolver: (fileStem) => `sweep/${fileStem}.md`,
    heading: '# Sweep',
    phase: TaskPhase.DONE,
  },
};

export function createExecutionArtifact(input: CreateExecutionArtifactInput): ExecutionArtifact {
  assertNonBlank(input.id, 'Execution Artifact id');
  assertNonBlank(input.taskId, 'Execution Artifact Task id');
  if (input.sessionId !== undefined) {
    assertNonBlank(input.sessionId, 'Execution Artifact Agent Session id');
  }
  assertTimestamp(input.createdAt);

  const contract = contracts[input.kind];
  if (contract === undefined) {
    throw new TypeError('Execution Artifact kind is not supported.');
  }
  assertValidContent(input.content, contract.heading);

  const dynamicPhase = isDynamicPhaseArtifactKind(input.kind);
  if (dynamicPhase) {
    if (input.sessionId === undefined) {
      throw new TypeError(
        `Execution Artifact kind "${input.kind}" requires an Agent Session id.`,
      );
    }
    if (input.phase === undefined) {
      throw new TypeError(
        `Execution Artifact kind "${input.kind}" requires the Task phase at capture-time.`,
      );
    }
  } else if (input.phase !== undefined && input.phase !== contract.phase) {
    throw new TypeError(
      `Execution Artifact kind "${input.kind}" cannot declare phase "${input.phase}".`,
    );
  }

  const resolvedPhase = input.phase ?? contract.phase;
  const fileStem = dynamicPhase ? `${input.taskId}-${input.sessionId}-${input.createdAt}` : '';
  const canonicalName = contract.canonicalNameResolver(fileStem);

  return Object.freeze({
    canonicalName,
    content: input.content,
    createdAt: input.createdAt,
    format: 'markdown',
    id: input.id,
    kind: input.kind,
    phase: resolvedPhase,
    schemaVersion: 1,
    sessionId: input.sessionId,
    taskId: input.taskId,
    validation: 'VALID',
  });
}

function assertValidContent(content: string, heading: string): void {
  if (
    typeof content !== 'string' ||
    content.length > maximumContentLength ||
    content.includes('\0')
  ) {
    throw new TypeError('Execution Artifact content is invalid.');
  }
  const normalized = content.replaceAll('\r\n', '\n');
  if (
    !normalized.startsWith(`${heading}\n\n`) ||
    normalized.slice(heading.length + 2).trim() === ''
  ) {
    throw new TypeError(`Execution Artifact content must contain ${heading} and a body.`);
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Execution Artifact creation timestamp must be a nonnegative integer.');
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
