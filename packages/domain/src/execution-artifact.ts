import { TaskPhase, type TaskPhase as TaskPhaseValue } from './task-phase';

export const ExecutionArtifactKind = Object.freeze({
  EXECUTION_SUMMARY: 'execution-summary',
  PLAN: 'plan',
  RESEARCH: 'research',
  REVIEW: 'review',
} as const);

export type ExecutionArtifactKind =
  (typeof ExecutionArtifactKind)[keyof typeof ExecutionArtifactKind];

export interface ExecutionArtifact {
  readonly canonicalName:
    | 'planning/plan.md'
    | 'research/research.md'
    | 'review/review.md'
    | 'running/execution-summary.md';
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
  readonly sessionId?: string;
  readonly taskId: string;
}

interface ExecutionArtifactContract {
  readonly canonicalName: ExecutionArtifact['canonicalName'];
  readonly heading: string;
  readonly phase: TaskPhaseValue;
}

const maximumContentLength = 1_048_576;

const contracts: Readonly<Record<ExecutionArtifactKind, ExecutionArtifactContract>> = {
  [ExecutionArtifactKind.EXECUTION_SUMMARY]: {
    canonicalName: 'running/execution-summary.md',
    heading: '# Execution Summary',
    phase: TaskPhase.RUNNING,
  },
  [ExecutionArtifactKind.PLAN]: {
    canonicalName: 'planning/plan.md',
    heading: '# Plan',
    phase: TaskPhase.PLANNING,
  },
  [ExecutionArtifactKind.RESEARCH]: {
    canonicalName: 'research/research.md',
    heading: '# Research',
    phase: TaskPhase.BACKLOG,
  },
  [ExecutionArtifactKind.REVIEW]: {
    canonicalName: 'review/review.md',
    heading: '# Review',
    phase: TaskPhase.REVIEW,
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

  return Object.freeze({
    canonicalName: contract.canonicalName,
    content: input.content,
    createdAt: input.createdAt,
    format: 'markdown',
    id: input.id,
    kind: input.kind,
    phase: contract.phase,
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
