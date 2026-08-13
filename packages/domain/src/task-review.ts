import {
  ExecutionArtifactKind,
  type ExecutionArtifactKind as ExecutionArtifactKindValue,
} from './execution-artifact';
import {
  QualityGateKind,
  QualityGateRunStatus,
  type QualityGateKind as QualityGateKindValue,
  type QualityGateRunStatus as QualityGateRunStatusValue,
} from './quality-gate';
import { TaskPhase, type TaskPhase as TaskPhaseValue } from './task-phase';

export const TaskReviewStatus = {
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  PENDING: 'PENDING',
} as const;

export type TaskReviewStatus = (typeof TaskReviewStatus)[keyof typeof TaskReviewStatus];

export const TaskReviewEvidenceLimits = Object.freeze({
  ARTIFACTS: 1_000,
  QUALITY_GATES: 1_000,
});

export const TaskReviewGateAssociation = {
  HEAD_MATCH_ONLY: 'HEAD_MATCH_ONLY',
  STALE: 'STALE',
} as const;

export type TaskReviewGateAssociation =
  (typeof TaskReviewGateAssociation)[keyof typeof TaskReviewGateAssociation];

export interface TaskReviewChanges {
  readonly committed: readonly string[];
  readonly conflicted: readonly string[];
  readonly staged: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface TaskReviewCodeState {
  readonly branchName: string;
  readonly baseCommitId: string;
  readonly changes: TaskReviewChanges;
  readonly fingerprint: string;
  readonly headCommitId: string;
  readonly schemaVersion: 1;
  readonly worktreePathIdentity: string;
}

export interface TaskReviewArtifactEvidence {
  readonly createdAt: number;
  readonly id: string;
  readonly kind: ExecutionArtifactKindValue;
  readonly phase: TaskPhaseValue;
  readonly sessionId: string | undefined;
}

export interface TaskReviewQualityGateEvidence {
  readonly association: TaskReviewGateAssociation;
  readonly baseCommitId: string;
  readonly branchName: string;
  readonly finishedAt: number | undefined;
  readonly gateId: string;
  readonly headCommitIdAtStart: string;
  readonly id: string;
  readonly kind: QualityGateKindValue;
  readonly observedStatus: QualityGateRunStatusValue;
  readonly startedAt: number;
  readonly worktreePathIdentity: string;
}

export interface TaskReview {
  readonly artifacts: readonly TaskReviewArtifactEvidence[];
  readonly codeState: TaskReviewCodeState;
  readonly decidedAt: number | undefined;
  readonly decisionNote: string | undefined;
  readonly id: string;
  readonly qualityGates: readonly TaskReviewQualityGateEvidence[];
  readonly requestedAt: number;
  readonly status: TaskReviewStatus;
  readonly taskId: string;
}

export interface StartTaskReviewInput {
  readonly artifacts: readonly TaskReviewArtifactEvidence[];
  readonly codeState: TaskReviewCodeState;
  readonly id: string;
  readonly qualityGates: readonly TaskReviewQualityGateEvidence[];
  readonly requestedAt: number;
  readonly taskId: string;
}

export type TaskReviewDecisionStatus =
  typeof TaskReviewStatus.APPROVED | typeof TaskReviewStatus.CHANGES_REQUESTED;

export interface DecideTaskReviewInput {
  readonly decidedAt: number;
  readonly decisionNote?: string;
  readonly status: TaskReviewDecisionStatus;
}

export class InvalidTaskReviewTransitionError extends Error {
  public readonly from: TaskReviewStatus;
  public readonly to: TaskReviewDecisionStatus;

  public constructor(from: TaskReviewStatus, to: TaskReviewDecisionStatus) {
    super(`Cannot decide a Task Review from ${from} to ${to}.`);
    this.name = 'InvalidTaskReviewTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function startTaskReview(input: StartTaskReviewInput): TaskReview {
  assertNonBlank(input.id, 'Task Review id');
  assertNonBlank(input.taskId, 'Task Review Task id');
  assertTimestamp(input.requestedAt, 'Task Review request timestamp');

  const codeState = createCodeState(input.codeState);
  const artifacts = createArtifactEvidence(input.artifacts, input.requestedAt);
  const qualityGates = createQualityGateEvidence(input.qualityGates, codeState, input.requestedAt);

  return Object.freeze({
    artifacts,
    codeState,
    decidedAt: undefined,
    decisionNote: undefined,
    id: input.id,
    qualityGates,
    requestedAt: input.requestedAt,
    status: TaskReviewStatus.PENDING,
    taskId: input.taskId,
  });
}

export function decideTaskReview(review: TaskReview, input: DecideTaskReviewInput): TaskReview {
  assertTaskReview(review);
  assertDecisionStatus(input.status);

  if (review.status !== TaskReviewStatus.PENDING) {
    throw new InvalidTaskReviewTransitionError(review.status, input.status);
  }

  assertTimestamp(input.decidedAt, 'Task Review decision timestamp');
  if (input.decidedAt < review.requestedAt) {
    throw new TypeError('Task Review cannot be decided before it is requested.');
  }
  if (input.decisionNote !== undefined) {
    assertNonBlank(input.decisionNote, 'Task Review decision note');
    if (input.decisionNote.length > 65_536) {
      throw new TypeError('Task Review decision note is too long.');
    }
  }

  return Object.freeze({
    ...review,
    decidedAt: input.decidedAt,
    decisionNote: input.decisionNote,
    status: input.status,
  });
}

function assertTaskReview(review: TaskReview): void {
  if (review === null || typeof review !== 'object') {
    throw new TypeError('Task Review snapshot is invalid.');
  }
  assertNonBlank(review.id, 'Task Review id');
  assertNonBlank(review.taskId, 'Task Review Task id');
  assertTimestamp(review.requestedAt, 'Task Review request timestamp');
  const codeState = createCodeState(review.codeState);
  createArtifactEvidence(review.artifacts, review.requestedAt);
  createQualityGateEvidence(review.qualityGates, codeState, review.requestedAt);
  assertEnumValue(review.status, Object.values(TaskReviewStatus), 'Task Review status');

  if (review.status === TaskReviewStatus.PENDING) {
    if (review.decidedAt !== undefined || review.decisionNote !== undefined) {
      throw new TypeError('Pending Task Review cannot contain a decision.');
    }
    return;
  }

  if (review.decidedAt === undefined) {
    throw new TypeError('Decided Task Review must contain a decision timestamp.');
  }
  assertTimestamp(review.decidedAt, 'Task Review decision timestamp');
  if (review.decidedAt < review.requestedAt) {
    throw new TypeError('Task Review cannot be decided before it is requested.');
  }
  if (review.decisionNote !== undefined) {
    assertNonBlank(review.decisionNote, 'Task Review decision note');
    if (review.decisionNote.length > 65_536) {
      throw new TypeError('Task Review decision note is too long.');
    }
  }
}

function createCodeState(input: TaskReviewCodeState): TaskReviewCodeState {
  if (input === null || typeof input !== 'object' || input.schemaVersion !== 1) {
    throw new TypeError('Task Review code state is invalid.');
  }
  assertSha256(input.fingerprint, 'Task Review code-state fingerprint');
  assertNonBlank(input.worktreePathIdentity, 'Task Review Worktree path identity');
  assertNonBlank(input.branchName, 'Task Review Worktree branch');
  assertGitObjectId(input.baseCommitId, 'Task Review Worktree base commit id');
  assertGitObjectId(input.headCommitId, 'Task Review Worktree HEAD commit id');

  return Object.freeze({
    branchName: input.branchName,
    baseCommitId: input.baseCommitId,
    changes: createChanges(input.changes),
    fingerprint: input.fingerprint,
    headCommitId: input.headCommitId,
    schemaVersion: 1,
    worktreePathIdentity: input.worktreePathIdentity,
  });
}

function createChanges(input: TaskReviewChanges): TaskReviewChanges {
  if (input === null || typeof input !== 'object' || typeof input.truncated !== 'boolean') {
    throw new TypeError('Task Review code changes are invalid.');
  }
  if (!Number.isSafeInteger(input.total) || input.total < 0) {
    throw new TypeError('Task Review code-change total must be a nonnegative safe integer.');
  }

  const committed = copyPaths(input.committed);
  const conflicted = copyPaths(input.conflicted);
  const staged = copyPaths(input.staged);
  const unstaged = copyPaths(input.unstaged);
  const untracked = copyPaths(input.untracked);
  const visibleTotal = new Set([...committed, ...conflicted, ...staged, ...unstaged, ...untracked])
    .size;
  const visibleEntries =
    committed.length + conflicted.length + staged.length + unstaged.length + untracked.length;
  if (visibleEntries > 200) {
    throw new TypeError('Task Review code changes contain too many visible paths.');
  }
  if (
    (!input.truncated && input.total !== visibleTotal) ||
    (input.truncated && input.total < visibleTotal)
  ) {
    throw new TypeError('Task Review code-change total does not match its paths.');
  }

  return Object.freeze({
    committed,
    conflicted,
    staged,
    total: input.total,
    truncated: input.truncated,
    unstaged,
    untracked,
  });
}

function copyPaths(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError('Task Review changed paths must be arrays.');
  }
  const paths = [...input];
  for (const path of paths) {
    assertNonBlank(path, 'Task Review changed path');
    if (path.length > 32_768) {
      throw new TypeError('Task Review changed path is too long.');
    }
  }
  if (new Set(paths).size !== paths.length) {
    throw new TypeError('Task Review changed paths must not contain duplicates.');
  }
  return Object.freeze(paths);
}

function createArtifactEvidence(
  input: readonly TaskReviewArtifactEvidence[],
  requestedAt: number,
): readonly TaskReviewArtifactEvidence[] {
  if (!Array.isArray(input)) {
    throw new TypeError('Task Review Artifact evidence must be an array.');
  }
  if (input.length > TaskReviewEvidenceLimits.ARTIFACTS) {
    throw new TypeError('Task Review Artifact evidence exceeds its association limit.');
  }
  const artifacts = input.map((artifact): TaskReviewArtifactEvidence => {
    if (artifact === null || typeof artifact !== 'object') {
      throw new TypeError('Task Review Artifact evidence is invalid.');
    }
    assertNonBlank(artifact.id, 'Task Review Artifact id');
    assertEnumValue(
      artifact.kind,
      Object.values(ExecutionArtifactKind),
      'Task Review Artifact kind',
    );
    assertEnumValue(artifact.phase, Object.values(TaskPhase), 'Task Review Artifact phase');
    if (artifact.phase !== artifactPhase[artifact.kind as ExecutionArtifactKindValue]) {
      throw new TypeError('Task Review Artifact kind does not match its producing phase.');
    }
    if (artifact.sessionId !== undefined) {
      assertNonBlank(artifact.sessionId, 'Task Review Artifact Agent Session id');
    }
    assertTimestamp(artifact.createdAt, 'Task Review Artifact creation timestamp');
    if (artifact.createdAt > requestedAt) {
      throw new TypeError('Task Review Artifact cannot be created after the review request.');
    }
    return Object.freeze({
      createdAt: artifact.createdAt,
      id: artifact.id,
      kind: artifact.kind,
      phase: artifact.phase,
      sessionId: artifact.sessionId,
    });
  });
  assertUniqueIds(artifacts, 'Task Review Artifact');
  return Object.freeze(artifacts);
}

const artifactPhase: Readonly<Record<ExecutionArtifactKindValue, TaskPhaseValue>> = {
  [ExecutionArtifactKind.EXECUTION_SUMMARY]: TaskPhase.RUNNING,
  [ExecutionArtifactKind.PLAN]: TaskPhase.PLANNING,
  [ExecutionArtifactKind.REVIEW]: TaskPhase.REVIEW,
};

function createQualityGateEvidence(
  input: readonly TaskReviewQualityGateEvidence[],
  codeState: TaskReviewCodeState,
  requestedAt: number,
): readonly TaskReviewQualityGateEvidence[] {
  if (!Array.isArray(input)) {
    throw new TypeError('Task Review Quality Gate evidence must be an array.');
  }
  if (input.length > TaskReviewEvidenceLimits.QUALITY_GATES) {
    throw new TypeError('Task Review Quality Gate evidence exceeds its association limit.');
  }
  const qualityGates = input.map((qualityGate): TaskReviewQualityGateEvidence => {
    if (qualityGate === null || typeof qualityGate !== 'object') {
      throw new TypeError('Task Review Quality Gate evidence is invalid.');
    }
    assertNonBlank(qualityGate.id, 'Task Review Quality Gate Run id');
    assertNonBlank(qualityGate.gateId, 'Task Review Quality Gate id');
    assertEnumValue(
      qualityGate.kind,
      Object.values(QualityGateKind),
      'Task Review Quality Gate kind',
    );
    assertEnumValue(
      qualityGate.observedStatus,
      Object.values(QualityGateRunStatus),
      'Task Review Quality Gate status',
    );
    assertNonBlank(
      qualityGate.worktreePathIdentity,
      'Task Review Quality Gate Worktree path identity',
    );
    assertNonBlank(qualityGate.branchName, 'Task Review Quality Gate Worktree branch');
    assertGitObjectId(qualityGate.baseCommitId, 'Task Review Quality Gate Worktree base commit id');
    assertGitObjectId(
      qualityGate.headCommitIdAtStart,
      'Task Review Quality Gate Worktree HEAD commit id',
    );
    assertTimestamp(qualityGate.startedAt, 'Task Review Quality Gate start timestamp');
    assertQualityGateFinish(qualityGate);
    if (
      qualityGate.startedAt > requestedAt ||
      (qualityGate.finishedAt !== undefined && qualityGate.finishedAt > requestedAt)
    ) {
      throw new TypeError('Task Review Quality Gate evidence cannot postdate the review request.');
    }
    assertEnumValue(
      qualityGate.association,
      Object.values(TaskReviewGateAssociation),
      'Task Review Quality Gate association',
    );
    if (qualityGate.association !== expectedAssociation(qualityGate, codeState)) {
      throw new TypeError('Task Review Quality Gate association does not match its code state.');
    }
    return Object.freeze({
      association: qualityGate.association,
      baseCommitId: qualityGate.baseCommitId,
      branchName: qualityGate.branchName,
      finishedAt: qualityGate.finishedAt,
      gateId: qualityGate.gateId,
      headCommitIdAtStart: qualityGate.headCommitIdAtStart,
      id: qualityGate.id,
      kind: qualityGate.kind,
      observedStatus: qualityGate.observedStatus,
      startedAt: qualityGate.startedAt,
      worktreePathIdentity: qualityGate.worktreePathIdentity,
    });
  });
  assertUniqueIds(qualityGates, 'Task Review Quality Gate Run');
  return Object.freeze(qualityGates);
}

function assertQualityGateFinish(qualityGate: TaskReviewQualityGateEvidence): void {
  if (qualityGate.observedStatus === QualityGateRunStatus.RUNNING) {
    if (qualityGate.finishedAt !== undefined) {
      throw new TypeError('Running Task Review Quality Gate cannot contain a finish timestamp.');
    }
    return;
  }

  if (qualityGate.finishedAt === undefined) {
    throw new TypeError('Terminal Task Review Quality Gate must contain a finish timestamp.');
  }
  assertTimestamp(qualityGate.finishedAt, 'Task Review Quality Gate finish timestamp');
  if (qualityGate.finishedAt < qualityGate.startedAt) {
    throw new TypeError('Task Review Quality Gate cannot finish before it starts.');
  }
}

function expectedAssociation(
  qualityGate: TaskReviewQualityGateEvidence,
  codeState: TaskReviewCodeState,
): TaskReviewGateAssociation {
  return qualityGate.worktreePathIdentity === codeState.worktreePathIdentity &&
    qualityGate.branchName === codeState.branchName &&
    qualityGate.baseCommitId === codeState.baseCommitId &&
    qualityGate.headCommitIdAtStart === codeState.headCommitId
    ? TaskReviewGateAssociation.HEAD_MATCH_ONLY
    : TaskReviewGateAssociation.STALE;
}

function assertUniqueIds(values: readonly { readonly id: string }[], entity: string): void {
  if (new Set(values.map(({ id }) => id)).size !== values.length) {
    throw new TypeError(`${entity} evidence must not contain duplicate ids.`);
  }
}

function assertDecisionStatus(value: string): asserts value is TaskReviewDecisionStatus {
  if (value !== TaskReviewStatus.APPROVED && value !== TaskReviewStatus.CHANGES_REQUESTED) {
    throw new TypeError('Task Review decision status is invalid.');
  }
}

function assertGitObjectId(value: string, field: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
}

function assertSha256(value: string, field: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} is invalid.`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must not be blank.`);
  }
}

function assertEnumValue<T extends string>(
  value: string,
  values: readonly T[],
  field: string,
): asserts value is T {
  if (!values.includes(value as T)) {
    throw new TypeError(`${field} is invalid.`);
  }
}
