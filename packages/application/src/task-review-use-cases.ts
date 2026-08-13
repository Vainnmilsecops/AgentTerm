import {
  TaskPhase,
  TaskReviewEvidenceLimits,
  TaskReviewGateAssociation,
  TaskReviewStatus,
  decideTaskReview,
  startTaskReview,
  transitionTask,
  type AgentSession,
  type Task,
  type TaskReview,
  type TaskReviewArtifactEvidence,
  type TaskReviewCodeState,
  type TaskReviewQualityGateEvidence,
} from '@agentterm/domain';

import { EntityAlreadyExistsError, EntityNotFoundError, TaskReviewReadinessError } from './errors';
import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  GitTaskWorktreeLifecycle,
  LocalProjectLocator,
  QualityGateRunRepository,
  TaskRepository,
  TaskReviewCodeInspector,
  TaskReviewRepository,
  TaskReviewQualityGateEvidenceSource,
  TaskReviewSessionRevision,
  TaskWorktree,
  TaskWorktreeRepository,
} from './ports';
import { inspectTaskWorktree, serializeTaskWorktreeOperation } from './task-worktree-use-cases';
import { serializeTaskWorkflow } from './task-workflow-serialization';

export interface RequestTaskReviewInput {
  readonly reviewId: string;
  readonly taskId: string;
}

export interface DecideTaskReviewRequest {
  readonly decisionNote?: string;
  readonly reviewId: string;
  readonly taskId: string;
}

export interface TaskReviewDependencies {
  readonly artifacts: ExecutionArtifactRepository;
  readonly clock: () => number;
  readonly codeInspector: TaskReviewCodeInspector;
  readonly git: GitTaskWorktreeLifecycle;
  readonly localProjects: LocalProjectLocator;
  readonly qualityGateRuns: QualityGateRunRepository;
  readonly reviews: TaskReviewRepository;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
  readonly worktrees: TaskWorktreeRepository;
}

export interface RequestTaskReviewResult {
  readonly context: {
    readonly artifacts: readonly TaskReviewArtifactEvidence[];
    readonly qualityGates: readonly TaskReviewQualityGateEvidence[];
  };
  readonly review: TaskReview;
  readonly task: Task;
}

export interface DecideTaskReviewResult {
  readonly review: TaskReview;
  readonly task: Task;
}

export async function requestTaskReview(
  input: RequestTaskReviewInput,
  dependencies: TaskReviewDependencies,
): Promise<RequestTaskReviewResult> {
  assertIdentity(input.reviewId, 'Task Review id');
  assertIdentity(input.taskId, 'Task id');
  return serializeTaskWorkflow(input.taskId, () =>
    serializeTaskWorktreeOperation(input.taskId, () =>
      requestTaskReviewExclusive(input, dependencies),
    ),
  );
}

async function requestTaskReviewExclusive(
  input: RequestTaskReviewInput,
  dependencies: TaskReviewDependencies,
): Promise<RequestTaskReviewResult> {
  const task = await requireTask(input.taskId, dependencies.tasks);
  const existing = await dependencies.reviews.findById(input.reviewId);
  if (existing !== undefined) {
    assertReviewTask(existing, input.taskId);
    if (existing.status === TaskReviewStatus.PENDING && task.phase === TaskPhase.REVIEW) {
      return restoreRequestResult(existing, task);
    }
    throw new EntityAlreadyExistsError('TaskReview', input.reviewId);
  }
  const legacyReviewRecovery =
    task.phase === TaskPhase.REVIEW &&
    (await dependencies.reviews.listRecentByTaskId(input.taskId, 1)).length === 0;
  const reviewTask = legacyReviewRecovery ? task : transitionTask(task, TaskPhase.REVIEW);
  const sessionHistory = await assertNoActiveSession(input.taskId, dependencies.sessions);
  const [artifactSnapshot, gateSnapshot] = await Promise.all([
    dependencies.artifacts.readReviewEvidenceByTaskId(
      input.taskId,
      TaskReviewEvidenceLimits.ARTIFACTS,
    ),
    dependencies.qualityGateRuns.readReviewEvidenceByTaskId(
      input.taskId,
      TaskReviewEvidenceLimits.QUALITY_GATES,
    ),
  ]);
  if (gateSnapshot.hasRunning) {
    throw new TaskReviewReadinessError('ACTIVE_QUALITY_GATE', input.taskId);
  }
  assertEvidenceWithinLimits(input.taskId, artifactSnapshot.totalCount, gateSnapshot.totalCount);
  const artifacts = artifactSnapshot.evidence;
  const qualityGates = gateSnapshot.evidence;
  const worktree = await requireReviewWorktree(input.taskId, dependencies);
  const codeState = await dependencies.codeInspector.inspect(worktree);
  assertCodeStateBelongsToWorktree(codeState, worktree, input.taskId);
  const requestedAt = maximumEvidenceTimestamp(dependencies.clock(), artifacts, qualityGates);
  const review = startTaskReview({
    artifacts,
    codeState,
    id: input.reviewId,
    qualityGates: qualityGates.map((run) => toQualityGateEvidence(run, codeState)),
    requestedAt,
    taskId: input.taskId,
  });

  await dependencies.reviews.begin(
    review,
    legacyReviewRecovery ? TaskPhase.REVIEW : TaskPhase.RUNNING,
    reviewTask,
    toSessionRevisions(sessionHistory),
  );
  return Object.freeze({
    context: Object.freeze({
      artifacts: review.artifacts,
      qualityGates: review.qualityGates,
    }),
    review,
    task: reviewTask,
  });
}

export async function approveTaskReview(
  input: DecideTaskReviewRequest,
  dependencies: TaskReviewDependencies,
): Promise<DecideTaskReviewResult> {
  return decideReview(input, dependencies, TaskReviewStatus.APPROVED);
}

export async function requestTaskChanges(
  input: DecideTaskReviewRequest,
  dependencies: TaskReviewDependencies,
): Promise<DecideTaskReviewResult> {
  assertIdentity(input.reviewId, 'Task Review id');
  assertIdentity(input.taskId, 'Task id');
  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await requireTask(input.taskId, dependencies.tasks);
    const pending = await dependencies.reviews.findById(input.reviewId);
    if (pending === undefined) {
      transitionTask(task, TaskPhase.RUNNING);
      throw new EntityNotFoundError('TaskReview', input.reviewId);
    }
    assertReviewTask(pending, input.taskId);
    if (
      pending.status === TaskReviewStatus.CHANGES_REQUESTED &&
      task.phase === TaskPhase.RUNNING &&
      pending.decisionNote === input.decisionNote
    ) {
      return Object.freeze({ review: pending, task });
    }
    const runningTask = transitionTask(task, TaskPhase.RUNNING);
    const review = decideTaskReview(pending, {
      decidedAt: Math.max(dependencies.clock(), pending.requestedAt),
      ...(input.decisionNote === undefined ? {} : { decisionNote: input.decisionNote }),
      status: TaskReviewStatus.CHANGES_REQUESTED,
    });
    await dependencies.reviews.decide(
      review,
      TaskReviewStatus.PENDING,
      TaskPhase.REVIEW,
      runningTask,
    );
    return Object.freeze({ review, task: runningTask });
  });
}

async function decideReview(
  input: DecideTaskReviewRequest,
  dependencies: TaskReviewDependencies,
  status: typeof TaskReviewStatus.APPROVED,
): Promise<DecideTaskReviewResult> {
  assertIdentity(input.reviewId, 'Task Review id');
  assertIdentity(input.taskId, 'Task id');
  return serializeTaskWorkflow(input.taskId, () =>
    serializeTaskWorktreeOperation(input.taskId, async () => {
      const task = await requireTask(input.taskId, dependencies.tasks);
      const pending = await requireReview(input.reviewId, dependencies.reviews);
      assertReviewTask(pending, input.taskId);
      if (
        pending.status === TaskReviewStatus.APPROVED &&
        task.phase === TaskPhase.DONE &&
        pending.decisionNote === input.decisionNote
      ) {
        return Object.freeze({ review: pending, task });
      }
      const doneTask = transitionTask(task, TaskPhase.DONE);
      // Validate PENDING before expensive Git inspection and before constructing a terminal result.
      const review = decideTaskReview(pending, {
        decidedAt: Math.max(dependencies.clock(), pending.requestedAt),
        ...(input.decisionNote === undefined ? {} : { decisionNote: input.decisionNote }),
        status,
      });
      await assertNoActiveSession(input.taskId, dependencies.sessions);
      const worktree = await requireReviewWorktree(input.taskId, dependencies);
      const currentCodeState = await dependencies.codeInspector.inspect(worktree);
      assertCodeStateBelongsToWorktree(currentCodeState, worktree, input.taskId);
      if (!sameCodeState(pending.codeState, currentCodeState)) {
        throw new TaskReviewReadinessError('STALE_CODE_STATE', input.taskId);
      }
      await dependencies.reviews.decide(
        review,
        TaskReviewStatus.PENDING,
        TaskPhase.REVIEW,
        doneTask,
      );
      return Object.freeze({ review, task: doneTask });
    }),
  );
}

async function restoreRequestResult(
  review: TaskReview,
  task: Task,
): Promise<RequestTaskReviewResult> {
  return Object.freeze({
    context: Object.freeze({
      artifacts: review.artifacts,
      qualityGates: review.qualityGates,
    }),
    review,
    task,
  });
}

export async function listTaskReviews(
  taskId: string,
  tasks: TaskRepository,
  reviews: TaskReviewRepository,
): Promise<readonly TaskReview[]> {
  assertIdentity(taskId, 'Task id');
  await requireTask(taskId, tasks);
  return reviews.listByTaskId(taskId);
}

async function requireTask(taskId: string, tasks: TaskRepository): Promise<Task> {
  const task = await tasks.findById(taskId);
  if (task === undefined) throw new EntityNotFoundError('Task', taskId);
  return task;
}

async function requireReview(reviewId: string, reviews: TaskReviewRepository): Promise<TaskReview> {
  const review = await reviews.findById(reviewId);
  if (review === undefined) throw new EntityNotFoundError('TaskReview', reviewId);
  return review;
}

function assertReviewTask(review: TaskReview, taskId: string): void {
  if (review.taskId !== taskId) {
    throw new TypeError('Task Review does not belong to the requested Task.');
  }
}

async function assertNoActiveSession(
  taskId: string,
  sessions: AgentSessionRepository,
): Promise<readonly AgentSession[]> {
  const history = await sessions.listByTaskId(taskId);
  if (history.some(hasUnsettledTaskCodeWriter)) {
    throw new TaskReviewReadinessError('ACTIVE_SESSION', taskId);
  }
  return history;
}

function toSessionRevisions(
  sessions: readonly AgentSession[],
): readonly TaskReviewSessionRevision[] {
  return Object.freeze(
    sessions.map(({ history, id }) => Object.freeze({ historySequence: history.length, id })),
  );
}

async function requireReviewWorktree(
  taskId: string,
  dependencies: Pick<TaskReviewDependencies, 'git' | 'localProjects' | 'tasks' | 'worktrees'>,
): Promise<TaskWorktree> {
  const inspected = await inspectTaskWorktree(
    { taskId },
    dependencies.tasks,
    dependencies.localProjects,
    dependencies.worktrees,
    dependencies.git,
  );
  if (inspected.persistedState !== 'PRESENT' || inspected.actual.kind !== 'present') {
    throw new TaskReviewReadinessError('WORKTREE_NOT_READY', taskId);
  }
  return inspected.actual.worktree;
}

export { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';

function assertCodeStateBelongsToWorktree(
  codeState: TaskReviewCodeState,
  worktree: TaskWorktree,
  taskId: string,
): void {
  if (
    codeState.worktreePathIdentity !== worktree.pathIdentity ||
    codeState.branchName !== worktree.branchName ||
    codeState.baseCommitId !== worktree.baseCommitId
  ) {
    throw new TaskReviewReadinessError('WORKTREE_NOT_READY', taskId);
  }
}

function toQualityGateEvidence(
  run: TaskReviewQualityGateEvidenceSource,
  codeState: TaskReviewCodeState,
): TaskReviewQualityGateEvidence {
  const matchingHead =
    run.worktreePathIdentity === codeState.worktreePathIdentity &&
    run.branchName === codeState.branchName &&
    run.baseCommitId === codeState.baseCommitId &&
    run.headCommitIdAtStart === codeState.headCommitId;
  return Object.freeze({
    ...run,
    association: matchingHead
      ? TaskReviewGateAssociation.HEAD_MATCH_ONLY
      : TaskReviewGateAssociation.STALE,
  });
}

function maximumEvidenceTimestamp(
  now: number,
  artifacts: readonly TaskReviewArtifactEvidence[],
  qualityGates: readonly TaskReviewQualityGateEvidenceSource[],
): number {
  let maximum = now;
  for (const artifact of artifacts) maximum = Math.max(maximum, artifact.createdAt);
  for (const run of qualityGates) {
    maximum = Math.max(maximum, run.startedAt, run.finishedAt ?? run.startedAt);
  }
  return maximum;
}

function assertEvidenceWithinLimits(
  taskId: string,
  artifactCount: number,
  qualityGateCount: number,
): void {
  if (
    artifactCount > TaskReviewEvidenceLimits.ARTIFACTS ||
    qualityGateCount > TaskReviewEvidenceLimits.QUALITY_GATES
  ) {
    throw new TaskReviewReadinessError('EVIDENCE_LIMIT_EXCEEDED', taskId);
  }
}

function sameCodeState(left: TaskReviewCodeState, right: TaskReviewCodeState): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.fingerprint === right.fingerprint &&
    left.worktreePathIdentity === right.worktreePathIdentity &&
    left.branchName === right.branchName &&
    left.baseCommitId === right.baseCommitId &&
    left.headCommitId === right.headCommitId &&
    JSON.stringify(left.changes) === JSON.stringify(right.changes)
  );
}

function assertIdentity(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
