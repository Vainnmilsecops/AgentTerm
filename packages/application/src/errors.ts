import type {
  PtyRuntimeFailureReason,
  PtyRuntimeOperation,
  TaskWorktree,
  TaskWorktreeEnsureResult,
  TaskWorktreeStatus,
} from './ports';
import type { AgentSession } from '@agentterm/domain';
import type { TaskPhase } from '@agentterm/domain';

export type EntityKind =
  'AgentSession' | 'ExecutionArtifact' | 'Project' | 'QualityGateRun' | 'Task' | 'TaskReview';

export class TaskDependencyProjectMismatchError extends Error {
  public constructor(
    public readonly taskId: string,
    public readonly dependencyTaskId: string,
  ) {
    super('A Task dependency must belong to the same Project.');
    this.name = 'TaskDependencyProjectMismatchError';
  }
}

export class TaskDependencyBlockedError extends Error {
  public constructor(
    public readonly taskId: string,
    public readonly blockingTaskIds: readonly string[],
  ) {
    super('The Task is blocked by incomplete required Tasks.');
    this.name = 'TaskDependencyBlockedError';
  }
}

export type TaskReviewReadinessFailure =
  | 'ACTIVE_QUALITY_GATE'
  | 'ACTIVE_SESSION'
  | 'EVIDENCE_LIMIT_EXCEEDED'
  | 'STALE_CODE_STATE'
  | 'WORKTREE_NOT_READY';

export class TaskReviewReadinessError extends Error {
  public readonly reason: TaskReviewReadinessFailure;
  public readonly taskId: string;

  public constructor(reason: TaskReviewReadinessFailure, taskId: string) {
    super(
      reason === 'ACTIVE_QUALITY_GATE'
        ? 'The Task still has an active Quality Gate run.'
        : reason === 'ACTIVE_SESSION'
          ? 'The Task still has an active Agent Session.'
          : reason === 'EVIDENCE_LIMIT_EXCEEDED'
            ? 'The Task has too much Artifact or Quality Gate history for one Review snapshot.'
            : reason === 'STALE_CODE_STATE'
              ? 'The Task code state changed after Review began.'
              : 'The Task primary Worktree is not ready for Review.',
    );
    this.name = 'TaskReviewReadinessError';
    this.reason = reason;
    this.taskId = taskId;
  }
}

export class TaskReviewFlowRequiredError extends Error {
  public readonly from: TaskPhase;
  public readonly to: TaskPhase;

  public constructor(from: TaskPhase, to: TaskPhase) {
    super(`The structured Review Flow is required for ${from} -> ${to}.`);
    this.name = 'TaskReviewFlowRequiredError';
    this.from = from;
    this.to = to;
  }
}

export type QualityGateExecutionFailure =
  | 'GATE_NOT_FOUND'
  | 'INVALID_ENVIRONMENT'
  | 'TASK_PHASE_NOT_RUNNABLE'
  | 'UNSAFE_COMMAND_METADATA'
  | 'WORKTREE_NOT_READY';

export class QualityGateExecutionError extends Error {
  public readonly reason: QualityGateExecutionFailure;
  public readonly taskId: string;

  public constructor(reason: QualityGateExecutionFailure, taskId: string) {
    super(
      reason === 'GATE_NOT_FOUND'
        ? 'The configured Quality Gate was not found.'
        : reason === 'INVALID_ENVIRONMENT'
          ? 'The Quality Gate environment is invalid.'
          : reason === 'TASK_PHASE_NOT_RUNNABLE'
            ? 'Quality Gates cannot start while the Task is in REVIEW or DONE.'
            : reason === 'UNSAFE_COMMAND_METADATA'
              ? 'The configured Quality Gate command contains unsafe persisted metadata.'
              : 'The Task primary Worktree is not ready for Quality Gate execution.',
    );
    this.name = 'QualityGateExecutionError';
    this.reason = reason;
    this.taskId = taskId;
  }
}

export class QualityGatePersistenceError extends Error {
  public readonly observedRun: import('@agentterm/domain').QualityGateRun;
  public readonly persistedStatus = 'RUNNING' as const;

  public constructor(
    observedRun: import('@agentterm/domain').QualityGateRun,
    options?: ErrorOptions,
  ) {
    super(
      'Quality Gate process evidence completed, but its final checkpoint was not persisted.',
      options,
    );
    this.name = 'QualityGatePersistenceError';
    this.observedRun = observedRun;
  }
}

export type QualityGateProcessUnsettledReason =
  'PROCESS_RESULT_UNAVAILABLE' | 'TERMINATION_UNCONFIRMED';

export class QualityGateProcessUnsettledError extends Error {
  public readonly observedOutput: Readonly<{ readonly text: string; readonly truncated: boolean }>;
  public readonly persistedStatus = 'RUNNING' as const;
  public readonly reason: QualityGateProcessUnsettledReason;
  public readonly run: import('@agentterm/domain').QualityGateRun;

  public constructor(
    run: import('@agentterm/domain').QualityGateRun,
    reason: QualityGateProcessUnsettledReason,
    observedOutput: Readonly<{ readonly text: string; readonly truncated: boolean }>,
    options?: ErrorOptions,
  ) {
    super('Quality Gate process settlement could not be confirmed.', options);
    this.name = 'QualityGateProcessUnsettledError';
    this.run = run;
    this.reason = reason;
    this.observedOutput = Object.freeze({ ...observedOutput });
  }
}
export type AgentAdapterFailureReason =
  'EXECUTABLE_NOT_FOUND' | 'INSPECTION_FAILED' | 'INVALID_LAUNCH_REQUEST';

export type ProjectOpenFailure =
  | 'GIT_INSPECTION_FAILED'
  | 'GIT_NOT_AVAILABLE'
  | 'INVALID_PATH'
  | 'NOT_GIT_REPOSITORY'
  | 'PATH_NOT_ACCESSIBLE'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_NOT_FOUND';

export type GitRepositoryInspectionFailure =
  | 'GIT_INSPECTION_FAILED'
  | 'GIT_NOT_AVAILABLE'
  | 'GIT_VERSION_UNSUPPORTED'
  | 'INVALID_PATH'
  | 'PATH_NOT_ACCESSIBLE'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_NOT_FOUND';

export type TaskWorktreeLifecycleFailure =
  | 'BASE_BRANCH_UNAVAILABLE'
  | 'BRANCH_COLLISION'
  | 'DIRTY_WORKTREE'
  | 'GIT_OPERATION_FAILED'
  | 'INVALID_WORKTREE_ROOT'
  | 'LOCKED_WORKTREE'
  | 'METADATA_MISMATCH'
  | 'OPERATION_IN_PROGRESS'
  | 'PATH_COLLISION'
  | 'PROJECT_NOT_LOCAL'
  | 'WORKTREE_MISMATCH';

export type TaskExecutionStartStage = 'SESSION_START' | 'TASK_STATE';
export type TaskExecutionRetryFailure =
  'ACTIVE_SESSION_EXISTS' | 'AGENT_NOT_CONFIGURED' | 'NO_RETRYABLE_SESSION' | 'RETRY_REQUIRED';

export class AgentAdapterError extends Error {
  public readonly reason: AgentAdapterFailureReason;

  public constructor(reason: AgentAdapterFailureReason) {
    super(agentAdapterFailureMessage(reason));
    this.name = 'AgentAdapterError';
    this.reason = reason;
  }
}

export class AgentNotConfiguredError extends Error {
  public readonly agentId: string;

  public constructor(agentId: string) {
    super('The selected coding agent is not configured.');
    this.name = 'AgentNotConfiguredError';
    this.agentId = agentId;
  }
}

export class TaskPlanningFlowRequiredError extends Error {
  public readonly from: TaskPhase;
  public readonly to: TaskPhase;

  public constructor(from: TaskPhase, to: TaskPhase) {
    super('The Task can enter RUNNING only through explicit plan acceptance.');
    this.name = 'TaskPlanningFlowRequiredError';
    this.from = from;
    this.to = to;
  }
}

export class TaskPlanningPhaseError extends Error {
  public readonly phase: TaskPhase;
  public readonly taskId: string;

  public constructor(taskId: string, phase: TaskPhase) {
    super(`Task ${taskId} cannot start planning from ${phase}.`);
    this.name = 'TaskPlanningPhaseError';
    this.phase = phase;
    this.taskId = taskId;
  }
}

export type TaskPlanReadinessFailure =
  'ACTIVE_SESSION' | 'PLAN_NOT_FOUND' | 'PLAN_NOT_LATEST' | 'PLAN_PROVENANCE_INVALID';

export class TaskPlanReadinessError extends Error {
  public readonly planId: string;
  public readonly reason: TaskPlanReadinessFailure;
  public readonly taskId: string;

  public constructor(reason: TaskPlanReadinessFailure, taskId: string, planId: string) {
    super('The selected Plan is not ready for acceptance.');
    this.name = 'TaskPlanReadinessError';
    this.planId = planId;
    this.reason = reason;
    this.taskId = taskId;
  }
}

export class AgentSessionPersistenceError extends Error {
  public readonly sessionId: string;

  public constructor(sessionId: string) {
    super(`Agent Session ${sessionId} runtime evidence was not persisted.`);
    this.name = 'AgentSessionPersistenceError';
    this.sessionId = sessionId;
  }
}

export class AgentSessionRuntimeOwnershipError extends Error {
  public readonly sessionId: string;

  public constructor(sessionId: string) {
    super(`Agent Session ${sessionId} does not have a runtime owned by this coordinator.`);
    this.name = 'AgentSessionRuntimeOwnershipError';
    this.sessionId = sessionId;
  }
}

export class AgentSessionActiveConflictError extends Error {
  public readonly taskId: string;

  public constructor(taskId: string) {
    super(`Task ${taskId} already has an active Agent Session.`);
    this.name = 'AgentSessionActiveConflictError';
    this.taskId = taskId;
  }
}

export class ArtifactProvenanceError extends Error {
  public readonly artifactId: string;
  public readonly sessionId: string;
  public readonly taskId: string;

  public constructor(artifactId: string, taskId: string, sessionId: string) {
    super(`Execution Artifact ${artifactId} Agent Session does not belong to Task ${taskId}.`);
    this.name = 'ArtifactProvenanceError';
    this.artifactId = artifactId;
    this.sessionId = sessionId;
    this.taskId = taskId;
  }
}

export class TaskExecutionStartError extends Error {
  public readonly session: AgentSession | undefined;
  public readonly sessionId: string;
  public readonly stage: TaskExecutionStartStage;
  public readonly taskId: string;
  public readonly worktree: TaskWorktreeEnsureResult;

  public constructor(
    stage: TaskExecutionStartStage,
    taskId: string,
    sessionId: string,
    worktree: TaskWorktreeEnsureResult,
    options: ErrorOptions & { readonly session?: AgentSession } = {},
  ) {
    super(
      stage === 'TASK_STATE'
        ? 'The Task Worktree is ready, but the Task execution state could not be confirmed.'
        : 'The Task Worktree is ready, but the Agent Session did not start successfully.',
      options,
    );
    this.name = 'TaskExecutionStartError';
    this.session = options.session;
    this.sessionId = sessionId;
    this.stage = stage;
    this.taskId = taskId;
    this.worktree = worktree;
  }
}

export class TaskExecutionRetryError extends Error {
  public readonly activeSessionId: string | undefined;
  public readonly reason: TaskExecutionRetryFailure;
  public readonly sessionId: string;
  public readonly taskId: string;

  public constructor(
    reason: TaskExecutionRetryFailure,
    taskId: string,
    sessionId: string,
    options: { readonly activeSessionId?: string } = {},
  ) {
    super(taskExecutionRetryFailureMessage(reason));
    this.name = 'TaskExecutionRetryError';
    this.activeSessionId = options.activeSessionId;
    this.reason = reason;
    this.sessionId = sessionId;
    this.taskId = taskId;
  }
}

export class TaskExecutionPhaseError extends Error {
  public readonly phase: TaskPhase;
  public readonly taskId: string;

  public constructor(taskId: string, phase: TaskPhase) {
    super(`Task ${taskId} cannot start execution from ${phase}.`);
    this.name = 'TaskExecutionPhaseError';
    this.phase = phase;
    this.taskId = taskId;
  }
}

export class EntityAlreadyExistsError extends Error {
  public readonly entity: EntityKind;
  public readonly id: string;

  public constructor(entity: EntityKind, id: string) {
    super(`${entity} ${id} already exists.`);
    this.name = 'EntityAlreadyExistsError';
    this.entity = entity;
    this.id = id;
  }
}

export class EntityNotFoundError extends Error {
  public readonly entity: EntityKind;
  public readonly id: string;

  public constructor(entity: EntityKind, id: string) {
    super(`${entity} ${id} was not found.`);
    this.name = 'EntityNotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

export class ProjectOpenError extends Error {
  public readonly path: string;
  public readonly reason: ProjectOpenFailure;

  public constructor(reason: ProjectOpenFailure, path: string) {
    super(projectOpenFailureMessage(reason));
    this.name = 'ProjectOpenError';
    this.path = path;
    this.reason = reason;
  }
}

export class PtyRuntimeError extends Error {
  public readonly operation: PtyRuntimeOperation;
  public readonly reason: PtyRuntimeFailureReason;

  public constructor(operation: PtyRuntimeOperation, reason: PtyRuntimeFailureReason) {
    super(ptyRuntimeFailureMessage(reason));
    this.name = 'PtyRuntimeError';
    this.operation = operation;
    this.reason = reason;
  }
}

export class GitRepositoryInspectionError extends Error {
  public readonly path: string;
  public readonly reason: GitRepositoryInspectionFailure;

  public constructor(reason: GitRepositoryInspectionFailure, path: string) {
    super(gitRepositoryInspectionFailureMessage(reason));
    this.name = 'GitRepositoryInspectionError';
    this.path = path;
    this.reason = reason;
  }
}

export class TaskWorktreeLifecycleError extends Error {
  public readonly reason: TaskWorktreeLifecycleFailure;
  public readonly recoveryPath: string | undefined;
  public readonly status: TaskWorktreeStatus | undefined;
  public readonly taskId: string;

  public constructor(
    reason: TaskWorktreeLifecycleFailure,
    taskId: string,
    options: {
      readonly cause?: unknown;
      readonly recoveryPath?: string;
      readonly status?: TaskWorktreeStatus;
    } = {},
  ) {
    super(taskWorktreeLifecycleFailureMessage(reason), { cause: options.cause });
    this.name = 'TaskWorktreeLifecycleError';
    this.reason = reason;
    this.recoveryPath = options.recoveryPath;
    this.status = options.status;
    this.taskId = taskId;
  }
}

export type TaskChangeInspectionFailure =
  'CHANGE_NOT_FOUND' | 'GIT_INSPECTION_FAILED' | 'WORKTREE_NOT_READY';

export class TaskChangeInspectionError extends Error {
  public readonly reason: TaskChangeInspectionFailure;
  public readonly taskId: string;

  public constructor(reason: TaskChangeInspectionFailure, taskId: string, options?: ErrorOptions) {
    super(
      reason === 'CHANGE_NOT_FOUND'
        ? 'The selected Task file change is no longer available.'
        : reason === 'WORKTREE_NOT_READY'
          ? 'The Task primary Worktree is not ready for change inspection.'
          : 'Task changes could not be inspected.',
      options,
    );
    this.name = 'TaskChangeInspectionError';
    this.reason = reason;
    this.taskId = taskId;
  }
}

export class TaskWorktreeMetadataConflictError extends Error {
  public readonly taskId: string;

  public constructor(taskId: string, options?: ErrorOptions) {
    super(`Task ${taskId} Worktree metadata conflicts with the requested operation.`, options);
    this.name = 'TaskWorktreeMetadataConflictError';
    this.taskId = taskId;
  }
}

export class TaskWorktreePersistenceError extends Error {
  public readonly gitState: 'PRESENT' | 'REMOVED';
  public readonly operation: 'cleanup' | 'ensure';
  public readonly worktree: TaskWorktree;

  public constructor(
    operation: 'cleanup' | 'ensure',
    gitState: 'PRESENT' | 'REMOVED',
    worktree: TaskWorktree,
    options?: ErrorOptions,
  ) {
    super(
      `Git Worktree is ${gitState}, but its ${operation} checkpoint was not persisted.`,
      options,
    );
    this.name = 'TaskWorktreePersistenceError';
    this.gitState = gitState;
    this.operation = operation;
    this.worktree = worktree;
  }
}

function gitRepositoryInspectionFailureMessage(reason: GitRepositoryInspectionFailure): string {
  switch (reason) {
    case 'INVALID_PATH':
      return 'Git repository path must be a valid absolute local path.';
    case 'PATH_NOT_FOUND':
      return 'Git repository path does not exist.';
    case 'PATH_NOT_DIRECTORY':
      return 'Git repository path is not a directory.';
    case 'PATH_NOT_ACCESSIBLE':
      return 'Git repository path is not accessible.';
    case 'GIT_NOT_AVAILABLE':
      return 'Git is not available.';
    case 'GIT_VERSION_UNSUPPORTED':
      return 'Git 2.45 or newer is required for safe repository status inspection.';
    case 'GIT_INSPECTION_FAILED':
      return 'Git repository inspection failed.';
  }
}

function agentAdapterFailureMessage(reason: AgentAdapterFailureReason): string {
  switch (reason) {
    case 'EXECUTABLE_NOT_FOUND':
      return 'The coding-agent executable was not found.';
    case 'INSPECTION_FAILED':
      return 'The coding-agent installation could not be inspected.';
    case 'INVALID_LAUNCH_REQUEST':
      return 'The coding-agent launch request is invalid.';
  }
}

function projectOpenFailureMessage(reason: ProjectOpenFailure): string {
  switch (reason) {
    case 'INVALID_PATH':
      return 'Project path must be a valid absolute local path.';
    case 'PATH_NOT_FOUND':
      return 'Project path does not exist.';
    case 'PATH_NOT_DIRECTORY':
      return 'Project path is not a directory.';
    case 'PATH_NOT_ACCESSIBLE':
      return 'Project path is not accessible.';
    case 'GIT_NOT_AVAILABLE':
      return 'Git is not available.';
    case 'NOT_GIT_REPOSITORY':
      return 'Project path is not a valid accessible Git working tree.';
    case 'GIT_INSPECTION_FAILED':
      return 'Git repository inspection failed.';
  }
}

function ptyRuntimeFailureMessage(reason: PtyRuntimeFailureReason): string {
  switch (reason) {
    case 'INVALID_EXECUTABLE':
      return 'Terminal executable path is invalid.';
    case 'INVALID_ARGUMENT':
      return 'Terminal process arguments are invalid.';
    case 'INVALID_WORKING_DIRECTORY':
      return 'Terminal working directory is invalid.';
    case 'INVALID_ENVIRONMENT':
      return 'Terminal process environment is invalid.';
    case 'INVALID_TERMINAL_SIZE':
      return 'Terminal size is invalid.';
    case 'INVALID_INPUT':
      return 'Terminal input is invalid.';
    case 'NOT_RUNNING':
      return 'The terminal process is not running.';
    case 'UNSUPPORTED_PLATFORM':
      return 'The terminal runtime is not supported on this platform.';
    case 'CONPTY_UNAVAILABLE':
      return 'Windows ConPTY is unavailable.';
    case 'RUNTIME_FAILURE':
      return 'The terminal runtime operation failed.';
  }
}

function taskWorktreeLifecycleFailureMessage(reason: TaskWorktreeLifecycleFailure): string {
  switch (reason) {
    case 'BASE_BRANCH_UNAVAILABLE':
      return 'A committed base branch is required to create a Task Worktree.';
    case 'BRANCH_COLLISION':
      return 'The deterministic Task branch is already associated with another Worktree.';
    case 'DIRTY_WORKTREE':
      return 'The Task Worktree contains recoverable changes that must be handled first.';
    case 'GIT_OPERATION_FAILED':
      return 'The Git Worktree operation failed.';
    case 'INVALID_WORKTREE_ROOT':
      return 'The managed Worktree root is invalid for this repository.';
    case 'LOCKED_WORKTREE':
      return 'The Task Worktree is locked and cannot be cleaned up.';
    case 'METADATA_MISMATCH':
      return 'Persisted Task Worktree metadata does not match its deterministic identity.';
    case 'OPERATION_IN_PROGRESS':
      return 'Another Task Worktree lifecycle operation is already in progress.';
    case 'PATH_COLLISION':
      return 'The deterministic Task Worktree path is already occupied.';
    case 'PROJECT_NOT_LOCAL':
      return 'The Task Project does not have a persisted local Git root.';
    case 'WORKTREE_MISMATCH':
      return 'The registered Worktree does not match the expected Task branch and repository.';
  }
}

function taskExecutionRetryFailureMessage(reason: TaskExecutionRetryFailure): string {
  switch (reason) {
    case 'ACTIVE_SESSION_EXISTS':
      return 'The Task already has an active Agent Session.';
    case 'AGENT_NOT_CONFIGURED':
      return 'The previous Agent Session belongs to an agent that is not configured.';
    case 'NO_RETRYABLE_SESSION':
      return 'The Task does not have a failed or exited Agent Session to retry.';
    case 'RETRY_REQUIRED':
      return 'The Task already has Session history and must use the Retry action.';
  }
}
