import type {
  LocalProject,
  TaskReviewQualityGateEvidenceSource,
  TaskWorktreeLifecycleState,
  TaskWorktreeRecord,
} from '@agentterm/application';
import {
  createAgentSession,
  completeQualityGateRun,
  createExecutionArtifact,
  createProject,
  createQualityGate,
  createTask,
  ExecutionArtifactKind,
  QualityGateKind,
  QualityGateRunStatus,
  startQualityGateRun,
  startTaskReview,
  TaskPhase,
  TaskReviewEvidenceLimits,
  transitionTask,
  decideTaskReview,
  recordAgentSessionEvent,
  type AgentSession,
  type AgentSessionEvent,
  type ExecutionArtifact,
  type Project,
  type QualityGateRun,
  type Task,
  type TaskReview,
  type TaskReviewArtifactEvidence,
  type TaskReviewQualityGateEvidence,
  type TaskPhase as TaskPhaseValue,
} from '@agentterm/domain';

import { SqlitePersistenceError } from './errors';

type SqliteRow = Readonly<Record<string, bigint | null | number | string | Uint8Array>>;

const taskPhaseProgression = [
  TaskPhase.BACKLOG,
  TaskPhase.PLANNING,
  TaskPhase.RUNNING,
  TaskPhase.REVIEW,
  TaskPhase.DONE,
] as const;

const taskWorktreeLifecycleStates = [
  'PROVISIONING',
  'PRESENT',
  'REMOVING',
  'REMOVED',
] as const satisfies readonly TaskWorktreeLifecycleState[];

export function mapProjectRow(row: SqliteRow): Project {
  return createProject({
    id: readText(row, 'id', 'Project'),
    name: readText(row, 'name', 'Project'),
  });
}

export function mapLocalProjectRow(row: SqliteRow): LocalProject {
  return Object.freeze({
    ...mapProjectRow(row),
    rootPath: readText(row, 'canonical_path', 'Local Project'),
  });
}

export function mapTaskRow(row: SqliteRow): Task {
  const storedPhase = readTaskPhase(row);
  const brief = readNullableText(row, 'brief', 'Task');
  let task = createTask({
    id: readText(row, 'id', 'Task'),
    projectId: readText(row, 'project_id', 'Task'),
    title: readText(row, 'title', 'Task'),
    ...(brief === undefined ? {} : { brief }),
  });

  for (const phase of taskPhaseProgression) {
    if (task.phase === storedPhase) {
      return task;
    }

    if (phase !== TaskPhase.BACKLOG) {
      task = transitionTask(task, phase);
    }
  }

  if (task.phase === storedPhase) {
    return task;
  }

  throw new SqlitePersistenceError(`Task ${task.id} has an unreachable persisted phase.`);
}

export function mapTaskWorktreeRow(row: SqliteRow): TaskWorktreeRecord {
  const lifecycleState = readText(row, 'lifecycle_state', 'Task Worktree');
  const baseCommitId = readNonBlankText(row, 'base_commit_id', 'Task Worktree');

  if (!taskWorktreeLifecycleStates.some((candidate) => candidate === lifecycleState)) {
    throw new SqlitePersistenceError(
      `Task Worktree row contains an invalid lifecycle state: ${lifecycleState}.`,
    );
  }

  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(baseCommitId)) {
    throw new SqlitePersistenceError('Task Worktree row contains an invalid base commit id.');
  }

  return Object.freeze({
    baseCommitId,
    baseRefName: readNonBlankText(row, 'base_ref_name', 'Task Worktree'),
    branchName: readNonBlankText(row, 'branch_name', 'Task Worktree'),
    lifecycleState: lifecycleState as TaskWorktreeLifecycleState,
    pathIdentity: readNonBlankText(row, 'path_identity', 'Task Worktree'),
    repositoryRootPath: readNonBlankText(row, 'repository_root_path', 'Task Worktree'),
    taskId: readNonBlankText(row, 'task_id', 'Task Worktree'),
    worktreePath: readNonBlankText(row, 'worktree_path', 'Task Worktree'),
  });
}

export function mapAgentSessionRows(
  sessionRow: SqliteRow,
  eventRows: readonly SqliteRow[],
): AgentSession {
  const createdAt = readSafeNonNegativeInteger(sessionRow, 'created_at', 'Agent Session');
  let session = createAgentSession({
    agentId: readNonBlankText(sessionRow, 'agent_id', 'Agent Session'),
    createdAt,
    id: readNonBlankText(sessionRow, 'id', 'Agent Session'),
    taskId: readNonBlankText(sessionRow, 'task_id', 'Agent Session'),
  });

  if (eventRows.length === 0) {
    throw new SqlitePersistenceError('Agent Session history is empty.');
  }
  const initialRow = eventRows[0];
  if (initialRow === undefined) {
    throw new SqlitePersistenceError('Agent Session history is empty.');
  }
  assertStoredEventMatches(session.history[0], initialRow);

  for (const row of eventRows.slice(1)) {
    try {
      session = recordAgentSessionEvent(session, mapAgentSessionEventInput(row));
    } catch (error) {
      throw new SqlitePersistenceError('Agent Session history contains an invalid transition.', {
        cause: error,
      });
    }
    assertStoredEventMatches(session.history.at(-1), row);
  }

  const storedSequence = readSafePositiveInteger(sessionRow, 'history_sequence', 'Agent Session');
  const storedStatus = readText(sessionRow, 'status', 'Agent Session');
  const storedEndedAt = readNullableSafeNonNegativeInteger(sessionRow, 'ended_at', 'Agent Session');
  if (
    session.history.length !== storedSequence ||
    session.status !== storedStatus ||
    session.endedAt !== storedEndedAt
  ) {
    throw new SqlitePersistenceError('Agent Session snapshot does not match its event history.');
  }
  return session;
}

export function mapQualityGateRunRow(row: SqliteRow): QualityGateRun {
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(readText(row, 'arguments_json', 'Quality Gate Run'));
  } catch (error) {
    throw new SqlitePersistenceError('Quality Gate Run arguments are not valid JSON.', {
      cause: error,
    });
  }
  if (
    !Array.isArray(argumentsValue) ||
    !argumentsValue.every((argument): argument is string => typeof argument === 'string')
  ) {
    throw new SqlitePersistenceError('Quality Gate Run arguments are not a string array.');
  }

  let running: QualityGateRun;
  try {
    running = startQualityGateRun({
      gate: createQualityGate({
        command: {
          arguments: argumentsValue,
          executablePath: readNonBlankText(row, 'executable_path', 'Quality Gate Run'),
        },
        id: readNonBlankText(row, 'gate_id', 'Quality Gate Run'),
        kind: readText(row, 'gate_kind', 'Quality Gate Run') as QualityGateRun['gate']['kind'],
        timeoutMs: readSafePositiveInteger(row, 'timeout_ms', 'Quality Gate Run'),
      }),
      id: readNonBlankText(row, 'id', 'Quality Gate Run'),
      startedAt: readSafeNonNegativeInteger(row, 'started_at', 'Quality Gate Run'),
      taskId: readNonBlankText(row, 'task_id', 'Quality Gate Run'),
      worktree: {
        baseCommitId: readNonBlankText(row, 'worktree_base_commit_id', 'Quality Gate Run'),
        branchName: readNonBlankText(row, 'worktree_branch_name', 'Quality Gate Run'),
        headCommitIdAtStart: readNonBlankText(row, 'worktree_head_commit_id', 'Quality Gate Run'),
        pathIdentity: readNonBlankText(row, 'worktree_path_identity', 'Quality Gate Run'),
        worktreePath: readNonBlankText(row, 'worktree_path', 'Quality Gate Run'),
      },
    });
  } catch (error) {
    throw new SqlitePersistenceError('Quality Gate Run identity is invalid.', { cause: error });
  }

  const storedStatus = readText(row, 'status', 'Quality Gate Run');
  if (storedStatus === QualityGateRunStatus.RUNNING) {
    assertQualityGateRunSnapshotMatches(running, row);
    return running;
  }

  const finishedAt = readSafeNonNegativeInteger(row, 'finished_at', 'Quality Gate Run');
  const output = {
    reference: readNonBlankText(row, 'output_reference', 'Quality Gate Run'),
    text: readText(row, 'output_text', 'Quality Gate Run'),
    truncated: readBooleanInteger(row, 'output_truncated', 'Quality Gate Run'),
  };
  let completed: QualityGateRun;
  try {
    switch (storedStatus) {
      case QualityGateRunStatus.PASSED:
      case QualityGateRunStatus.FAILED:
        completed = completeQualityGateRun(running, {
          exitCode: readInteger(row, 'exit_code', 'Quality Gate Run'),
          finishedAt,
          kind: 'exited',
          output,
        });
        break;
      case QualityGateRunStatus.TIMED_OUT:
        completed = completeQualityGateRun(running, { finishedAt, kind: 'timed-out', output });
        break;
      case QualityGateRunStatus.LAUNCH_FAILED:
        completed = completeQualityGateRun(running, {
          finishedAt,
          kind: 'launch-failed',
          output,
        });
        break;
      case QualityGateRunStatus.INFRASTRUCTURE_FAILED:
        completed = completeQualityGateRun(running, {
          finishedAt,
          kind: 'infrastructure-failed',
          output,
        });
        break;
      default:
        throw new SqlitePersistenceError(`Quality Gate Run status is invalid: ${storedStatus}.`);
    }
  } catch (error) {
    if (error instanceof SqlitePersistenceError) {
      throw error;
    }
    throw new SqlitePersistenceError('Quality Gate Run terminal evidence is invalid.', {
      cause: error,
    });
  }
  assertQualityGateRunSnapshotMatches(completed, row);
  return completed;
}

export function mapTaskReviewArtifactEvidenceSourceRow(row: SqliteRow): TaskReviewArtifactEvidence {
  const sessionId = readNullableText(row, 'session_id', 'Task Review Artifact source');
  const kind = readText(row, 'kind', 'Task Review Artifact source');
  if (!Object.values(ExecutionArtifactKind).some((candidate) => candidate === kind)) {
    throw new SqlitePersistenceError(
      `Task Review Artifact source contains an invalid kind: ${kind}.`,
    );
  }
  const phase = readText(row, 'phase', 'Task Review Artifact source');
  if (!taskPhaseProgression.some((candidate) => candidate === phase)) {
    throw new SqlitePersistenceError(
      `Task Review Artifact source contains an invalid phase: ${phase}.`,
    );
  }
  return Object.freeze({
    createdAt: readSafeNonNegativeInteger(row, 'created_at', 'Task Review Artifact source'),
    id: readNonBlankText(row, 'artifact_id', 'Task Review Artifact source'),
    kind: kind as TaskReviewArtifactEvidence['kind'],
    phase: phase as TaskReviewArtifactEvidence['phase'],
    sessionId,
  });
}

export function mapTaskReviewQualityGateEvidenceSourceRow(
  row: SqliteRow,
): TaskReviewQualityGateEvidenceSource {
  const kind = readText(row, 'kind', 'Task Review Quality Gate source');
  if (!Object.values(QualityGateKind).some((candidate) => candidate === kind)) {
    throw new SqlitePersistenceError(
      `Task Review Quality Gate source contains an invalid kind: ${kind}.`,
    );
  }
  const observedStatus = readText(row, 'observed_status', 'Task Review Quality Gate source');
  if (!Object.values(QualityGateRunStatus).some((candidate) => candidate === observedStatus)) {
    throw new SqlitePersistenceError(
      `Task Review Quality Gate source contains an invalid status: ${observedStatus}.`,
    );
  }
  return Object.freeze({
    baseCommitId: readNonBlankText(row, 'base_commit_id', 'Task Review Quality Gate source'),
    branchName: readNonBlankText(row, 'branch_name', 'Task Review Quality Gate source'),
    finishedAt: readNullableSafeNonNegativeInteger(
      row,
      'finished_at',
      'Task Review Quality Gate source',
    ),
    gateId: readNonBlankText(row, 'gate_id', 'Task Review Quality Gate source'),
    headCommitIdAtStart: readNonBlankText(
      row,
      'head_commit_id_at_start',
      'Task Review Quality Gate source',
    ),
    id: readNonBlankText(row, 'quality_gate_run_id', 'Task Review Quality Gate source'),
    kind: kind as TaskReviewQualityGateEvidenceSource['kind'],
    observedStatus: observedStatus as TaskReviewQualityGateEvidenceSource['observedStatus'],
    startedAt: readSafeNonNegativeInteger(row, 'started_at', 'Task Review Quality Gate source'),
    worktreePathIdentity: readNonBlankText(
      row,
      'worktree_path_identity',
      'Task Review Quality Gate source',
    ),
  });
}

function assertQualityGateRunSnapshotMatches(run: QualityGateRun, row: SqliteRow): void {
  const durationMs = readNullableSafeNonNegativeInteger(row, 'duration_ms', 'Quality Gate Run');
  const exitCode = readNullableInteger(row, 'exit_code', 'Quality Gate Run');
  const failureCategory = readNullableText(row, 'failure_category', 'Quality Gate Run');
  const finishedAt = readNullableSafeNonNegativeInteger(row, 'finished_at', 'Quality Gate Run');
  if (
    run.status !== readText(row, 'status', 'Quality Gate Run') ||
    run.durationMs !== durationMs ||
    run.exitCode !== exitCode ||
    run.failureCategory !== failureCategory ||
    run.finishedAt !== finishedAt
  ) {
    throw new SqlitePersistenceError('Quality Gate Run snapshot does not match Domain evidence.');
  }
  if (run.output === undefined) {
    if (
      row.output_reference !== null ||
      row.output_text !== null ||
      row.output_truncated !== null
    ) {
      throw new SqlitePersistenceError('RUNNING Quality Gate Run contains terminal output.');
    }
    return;
  }
  if (
    run.output.reference !== readNonBlankText(row, 'output_reference', 'Quality Gate Run') ||
    run.output.text !== readText(row, 'output_text', 'Quality Gate Run') ||
    run.output.truncated !== readBooleanInteger(row, 'output_truncated', 'Quality Gate Run')
  ) {
    throw new SqlitePersistenceError('Quality Gate Run output does not match Domain evidence.');
  }
}

export function mapExecutionArtifactRow(row: SqliteRow): ExecutionArtifact {
  const sessionValue = row.session_id;
  if (sessionValue !== null && typeof sessionValue !== 'string') {
    throw new SqlitePersistenceError(
      'Execution Artifact row contains an invalid session_id column.',
    );
  }
  const kind = readText(row, 'kind', 'Execution Artifact');
  if (!['execution-summary', 'plan', 'review'].includes(kind)) {
    throw new SqlitePersistenceError(`Execution Artifact row contains an invalid kind: ${kind}.`);
  }

  let artifact: ExecutionArtifact;
  try {
    artifact = createExecutionArtifact({
      content: readText(row, 'content', 'Execution Artifact'),
      createdAt: readSafeNonNegativeInteger(row, 'created_at', 'Execution Artifact'),
      id: readNonBlankText(row, 'id', 'Execution Artifact'),
      kind: kind as ExecutionArtifact['kind'],
      ...(sessionValue === null ? {} : { sessionId: sessionValue }),
      taskId: readNonBlankText(row, 'task_id', 'Execution Artifact'),
    });
  } catch (error) {
    throw new SqlitePersistenceError('Execution Artifact row contains invalid content.', {
      cause: error,
    });
  }

  if (
    artifact.canonicalName !== readText(row, 'canonical_name', 'Execution Artifact') ||
    artifact.phase !== readText(row, 'phase', 'Execution Artifact') ||
    artifact.format !== readText(row, 'format', 'Execution Artifact') ||
    artifact.schemaVersion !==
      readSafePositiveInteger(row, 'schema_version', 'Execution Artifact') ||
    artifact.validation !== readText(row, 'validation', 'Execution Artifact')
  ) {
    throw new SqlitePersistenceError(
      'Execution Artifact persisted metadata does not match its Domain contract.',
    );
  }
  return artifact;
}

export function mapTaskReviewRows(
  reviewRow: SqliteRow,
  changedPathRows: readonly SqliteRow[],
  artifactRows: readonly SqliteRow[],
  qualityGateRows: readonly SqliteRow[],
): TaskReview {
  if (
    artifactRows.length > TaskReviewEvidenceLimits.ARTIFACTS ||
    qualityGateRows.length > TaskReviewEvidenceLimits.QUALITY_GATES
  ) {
    throw new SqlitePersistenceError(
      'Task Review evidence associations exceed their storage bound.',
    );
  }
  const paths: Record<'COMMITTED' | 'CONFLICTED' | 'STAGED' | 'UNSTAGED' | 'UNTRACKED', string[]> =
    {
      COMMITTED: [],
      CONFLICTED: [],
      STAGED: [],
      UNSTAGED: [],
      UNTRACKED: [],
    };
  const categoryOrdinals = new Map<string, number>();
  for (const row of changedPathRows) {
    const category = readText(row, 'category', 'Task Review changed path');
    if (!(category in paths)) {
      throw new SqlitePersistenceError(
        `Task Review changed path contains an invalid category: ${category}.`,
      );
    }
    const expectedOrdinal = (categoryOrdinals.get(category) ?? 0) + 1;
    if (readSafePositiveInteger(row, 'ordinal', 'Task Review changed path') !== expectedOrdinal) {
      throw new SqlitePersistenceError('Task Review changed path history is not contiguous.');
    }
    categoryOrdinals.set(category, expectedOrdinal);
    paths[category as keyof typeof paths].push(
      readNonBlankText(row, 'path', 'Task Review changed path'),
    );
  }
  const visiblePaths = Object.values(paths).flat();
  if (visiblePaths.length > 200 || visiblePaths.some((path) => path.length > 32_768)) {
    throw new SqlitePersistenceError(
      'Task Review changed-path evidence exceeds its storage bound.',
    );
  }

  const artifacts = artifactRows.map((row, index): TaskReviewArtifactEvidence => {
    assertOrdinal(row, index, 'Task Review Artifact evidence');
    const sessionId = readNullableText(row, 'session_id', 'Task Review Artifact evidence');
    return {
      createdAt: readSafeNonNegativeInteger(row, 'created_at', 'Task Review Artifact evidence'),
      id: readNonBlankText(row, 'artifact_id', 'Task Review Artifact evidence'),
      kind: readText(
        row,
        'kind',
        'Task Review Artifact evidence',
      ) as TaskReviewArtifactEvidence['kind'],
      phase: readText(
        row,
        'phase',
        'Task Review Artifact evidence',
      ) as TaskReviewArtifactEvidence['phase'],
      sessionId,
    };
  });
  const qualityGates = qualityGateRows.map((row, index): TaskReviewQualityGateEvidence => {
    assertOrdinal(row, index, 'Task Review Quality Gate evidence');
    const finishedAt = readNullableSafeNonNegativeInteger(
      row,
      'finished_at',
      'Task Review Quality Gate evidence',
    );
    return {
      association: readText(
        row,
        'association',
        'Task Review Quality Gate evidence',
      ) as TaskReviewQualityGateEvidence['association'],
      baseCommitId: readNonBlankText(row, 'base_commit_id', 'Task Review Quality Gate evidence'),
      branchName: readNonBlankText(row, 'branch_name', 'Task Review Quality Gate evidence'),
      finishedAt,
      gateId: readNonBlankText(row, 'gate_id', 'Task Review Quality Gate evidence'),
      headCommitIdAtStart: readNonBlankText(
        row,
        'head_commit_id_at_start',
        'Task Review Quality Gate evidence',
      ),
      id: readNonBlankText(row, 'quality_gate_run_id', 'Task Review Quality Gate evidence'),
      kind: readText(
        row,
        'kind',
        'Task Review Quality Gate evidence',
      ) as TaskReviewQualityGateEvidence['kind'],
      observedStatus: readText(
        row,
        'observed_status',
        'Task Review Quality Gate evidence',
      ) as TaskReviewQualityGateEvidence['observedStatus'],
      startedAt: readSafeNonNegativeInteger(row, 'started_at', 'Task Review Quality Gate evidence'),
      worktreePathIdentity: readNonBlankText(
        row,
        'worktree_path_identity',
        'Task Review Quality Gate evidence',
      ),
    };
  });

  let review: TaskReview;
  try {
    review = startTaskReview({
      artifacts,
      codeState: {
        baseCommitId: readNonBlankText(reviewRow, 'base_commit_id', 'Task Review'),
        branchName: readNonBlankText(reviewRow, 'branch_name', 'Task Review'),
        changes: {
          committed: paths.COMMITTED,
          conflicted: paths.CONFLICTED,
          staged: paths.STAGED,
          total: readSafeNonNegativeInteger(reviewRow, 'changes_total', 'Task Review'),
          truncated: readBooleanInteger(reviewRow, 'changes_truncated', 'Task Review'),
          unstaged: paths.UNSTAGED,
          untracked: paths.UNTRACKED,
        },
        fingerprint: readNonBlankText(reviewRow, 'code_state_fingerprint', 'Task Review'),
        headCommitId: readNonBlankText(reviewRow, 'head_commit_id', 'Task Review'),
        schemaVersion: readSafePositiveInteger(
          reviewRow,
          'code_schema_version',
          'Task Review',
        ) as 1,
        worktreePathIdentity: readNonBlankText(reviewRow, 'worktree_path_identity', 'Task Review'),
      },
      id: readNonBlankText(reviewRow, 'id', 'Task Review'),
      qualityGates,
      requestedAt: readSafeNonNegativeInteger(reviewRow, 'requested_at', 'Task Review'),
      taskId: readNonBlankText(reviewRow, 'task_id', 'Task Review'),
    });

    const status = readText(reviewRow, 'status', 'Task Review');
    if (status !== 'PENDING') {
      if (status !== 'APPROVED' && status !== 'CHANGES_REQUESTED') {
        throw new SqlitePersistenceError(`Task Review status is invalid: ${status}.`);
      }
      const decidedAt = readSafeNonNegativeInteger(reviewRow, 'decided_at', 'Task Review');
      const decisionNote = readNullableText(reviewRow, 'decision_note', 'Task Review');
      if (decisionNote !== undefined && decisionNote.length > 65_536) {
        throw new SqlitePersistenceError('Task Review decision note exceeds its storage bound.');
      }
      review = decideTaskReview(review, {
        decidedAt,
        ...(decisionNote === undefined ? {} : { decisionNote }),
        status,
      });
    }
  } catch (error) {
    if (error instanceof SqlitePersistenceError) {
      throw error;
    }
    throw new SqlitePersistenceError('Task Review row contains invalid Domain evidence.', {
      cause: error,
    });
  }

  if (
    review.decidedAt !==
      readNullableSafeNonNegativeInteger(reviewRow, 'decided_at', 'Task Review') ||
    review.decisionNote !== readNullableText(reviewRow, 'decision_note', 'Task Review') ||
    review.status !== readText(reviewRow, 'status', 'Task Review')
  ) {
    throw new SqlitePersistenceError('Task Review snapshot does not match Domain evidence.');
  }
  return review;
}

function assertOrdinal(row: SqliteRow, index: number, entity: string): void {
  if (readSafePositiveInteger(row, 'ordinal', entity) !== index + 1) {
    throw new SqlitePersistenceError(`${entity} history is not contiguous.`);
  }
}

function mapAgentSessionEventInput(row: SqliteRow): Parameters<typeof recordAgentSessionEvent>[1] {
  const kind = readText(row, 'kind', 'Agent Session event');
  const occurredAt = readSafeNonNegativeInteger(row, 'occurred_at', 'Agent Session event');
  const runtimeSequence = readNullableSafePositiveInteger(
    row,
    'runtime_sequence',
    'Agent Session event',
  );
  switch (kind) {
    case 'STATUS_REPORTED': {
      const status = readText(row, 'status', 'Agent Session event');
      const source = readText(row, 'source', 'Agent Session event');
      if (
        !['IDLE', 'WAITING_INPUT', 'WORKING'].includes(status) ||
        !['APPLICATION', 'RUNTIME'].includes(source)
      ) {
        throw new SqlitePersistenceError('Agent Session status event is invalid.');
      }
      return {
        kind,
        occurredAt,
        ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
        source: source as 'APPLICATION' | 'RUNTIME',
        status: status as 'IDLE' | 'WAITING_INPUT' | 'WORKING',
      };
    }
    case 'STOP_REQUESTED':
      return { kind, occurredAt };
    case 'RUNTIME_FAILED': {
      const fatal = readInteger(row, 'fatal', 'Agent Session event');
      const stage = readText(row, 'stage', 'Agent Session event');
      if (
        ![0, 1].includes(fatal) ||
        !['CLEANUP', 'RESIZE', 'RUNTIME', 'START', 'TERMINATE', 'WRITE'].includes(stage)
      ) {
        throw new SqlitePersistenceError('Agent Session failure event is invalid.');
      }
      return {
        code: readNonBlankText(row, 'failure_code', 'Agent Session event'),
        fatal: fatal === 1,
        kind,
        occurredAt,
        ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
        stage: stage as 'CLEANUP' | 'RESIZE' | 'RUNTIME' | 'START' | 'TERMINATE' | 'WRITE',
      };
    }
    case 'PROCESS_EXITED': {
      const reason = readText(row, 'exit_reason', 'Agent Session event');
      if (runtimeSequence === undefined || !['PROCESS_EXIT', 'STOPPED'].includes(reason)) {
        throw new SqlitePersistenceError('Agent Session exit event is invalid.');
      }
      const signal = readNullableInteger(row, 'signal', 'Agent Session event');
      return {
        exitCode: readInteger(row, 'exit_code', 'Agent Session event'),
        kind,
        occurredAt,
        reason: reason as 'PROCESS_EXIT' | 'STOPPED',
        runtimeSequence,
        ...(signal === undefined ? {} : { signal }),
      };
    }
    default:
      throw new SqlitePersistenceError(`Agent Session event kind is invalid: ${kind}.`);
  }
}

function assertStoredEventMatches(event: AgentSessionEvent | undefined, row: SqliteRow): void {
  if (
    event === undefined ||
    event.sequence !== readSafePositiveInteger(row, 'sequence', 'Agent Session event') ||
    event.kind !== readText(row, 'kind', 'Agent Session event') ||
    event.status !== readText(row, 'status', 'Agent Session event') ||
    event.occurredAt !== readSafeNonNegativeInteger(row, 'occurred_at', 'Agent Session event')
  ) {
    throw new SqlitePersistenceError('Agent Session event row does not match Domain history.');
  }
}

function readTaskPhase(row: SqliteRow): TaskPhaseValue {
  const phase = readText(row, 'phase', 'Task');

  if (!taskPhaseProgression.some((candidate) => candidate === phase)) {
    throw new SqlitePersistenceError(`Task row contains an invalid phase: ${phase}.`);
  }

  return phase as TaskPhaseValue;
}

function readText(row: SqliteRow, column: string, entity: string): string {
  const value = row[column];

  if (typeof value !== 'string') {
    throw new SqlitePersistenceError(`${entity} row contains a non-text ${column} column.`);
  }

  return value;
}

function readNonBlankText(row: SqliteRow, column: string, entity: string): string {
  const value = readText(row, column, entity);

  if (value.trim().length === 0) {
    throw new SqlitePersistenceError(`${entity} row contains a blank ${column} column.`);
  }

  return value;
}

function readInteger(row: SqliteRow, column: string, entity: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SqlitePersistenceError(`${entity} row contains an invalid ${column} integer.`);
  }
  return value;
}

function readSafeNonNegativeInteger(row: SqliteRow, column: string, entity: string): number {
  const value = readInteger(row, column, entity);
  if (value < 0) {
    throw new SqlitePersistenceError(`${entity} row contains a negative ${column}.`);
  }
  return value;
}

function readSafePositiveInteger(row: SqliteRow, column: string, entity: string): number {
  const value = readInteger(row, column, entity);
  if (value <= 0) {
    throw new SqlitePersistenceError(`${entity} row contains a nonpositive ${column}.`);
  }
  return value;
}

function readNullableInteger(row: SqliteRow, column: string, entity: string): number | undefined {
  return row[column] === null ? undefined : readInteger(row, column, entity);
}

function readNullableText(row: SqliteRow, column: string, entity: string): string | undefined {
  return row[column] === null ? undefined : readNonBlankText(row, column, entity);
}

function readBooleanInteger(row: SqliteRow, column: string, entity: string): boolean {
  const value = readInteger(row, column, entity);
  if (value !== 0 && value !== 1) {
    throw new SqlitePersistenceError(`${entity} row contains an invalid ${column} boolean.`);
  }
  return value === 1;
}

function readNullableSafePositiveInteger(
  row: SqliteRow,
  column: string,
  entity: string,
): number | undefined {
  return row[column] === null ? undefined : readSafePositiveInteger(row, column, entity);
}

function readNullableSafeNonNegativeInteger(
  row: SqliteRow,
  column: string,
  entity: string,
): number | undefined {
  return row[column] === null ? undefined : readSafeNonNegativeInteger(row, column, entity);
}
