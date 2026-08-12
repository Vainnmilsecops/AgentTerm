import type {
  PtyRuntimeFailureReason,
  PtyRuntimeOperation,
  TaskWorktree,
  TaskWorktreeStatus,
} from './ports';

export type EntityKind = 'Project' | 'Task';

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

export class AgentAdapterError extends Error {
  public readonly reason: AgentAdapterFailureReason;

  public constructor(reason: AgentAdapterFailureReason) {
    super(agentAdapterFailureMessage(reason));
    this.name = 'AgentAdapterError';
    this.reason = reason;
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
