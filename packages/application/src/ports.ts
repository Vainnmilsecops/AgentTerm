import type {
  AgentSession,
  ExecutionArtifact,
  Project,
  QualityGate,
  QualityGateRun,
  Task,
  TaskReview,
  TaskReviewArtifactEvidence,
  TaskReviewCodeState,
  TaskReviewQualityGateEvidence,
} from '@agentterm/domain';

export interface AgentVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export interface AgentIdentity {
  readonly displayName: string;
  readonly id: string;
}

export type AgentCapability = 'SESSION_RESUME';

export type AgentAvailability =
  | {
      readonly capabilities: readonly AgentCapability[];
      readonly executablePath: string;
      readonly kind: 'available';
      readonly version?: AgentVersion;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'EXECUTABLE_NOT_FOUND' | 'INSPECTION_FAILED';
    };

export interface AgentLaunchRequest {
  /** The complete environment passed to the agent process. */
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export interface AgentLaunchCommand extends AgentLaunchRequest {
  readonly arguments: readonly string[];
  readonly executablePath: string;
}

export interface AgentAdapter {
  readonly identity: AgentIdentity;
  inspect(): Promise<AgentAvailability>;
  buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand>;
}

export interface AgentCatalog {
  findById(id: string): AgentAdapter | undefined;
  list(): readonly AgentAdapter[];
}

export interface AgentSessionRepository {
  findById(id: string): Promise<AgentSession | undefined>;
  /** Inserts one new attempt and must never replace history or admit a second active attempt for its Task. */
  insert(session: AgentSession): Promise<void>;
  /** Atomically appends the new history suffix when the stored revision matches. */
  append(session: AgentSession, expectedSequence: number): Promise<void>;
  /** Returns sessions whose status/history still indicates possible live runtime ownership. */
  listActive(): Promise<readonly AgentSession[]>;
  /** Returns session attempts from oldest to newest. */
  listByTaskId(taskId: string): Promise<readonly AgentSession[]>;
}

export interface TaskReviewArtifactEvidenceSnapshot {
  /** Empty when totalCount exceeds the requested admission limit. */
  readonly evidence: readonly TaskReviewArtifactEvidence[];
  readonly totalCount: number;
}

export type TaskReviewQualityGateEvidenceSource = Omit<
  TaskReviewQualityGateEvidence,
  'association'
>;

export interface TaskReviewQualityGateEvidenceSnapshot {
  /** Empty when totalCount exceeds the requested admission limit. */
  readonly evidence: readonly TaskReviewQualityGateEvidenceSource[];
  readonly hasRunning: boolean;
  readonly totalCount: number;
}

export interface ExecutionArtifactRepository {
  findById(id: string): Promise<ExecutionArtifact | undefined>;
  /** Inserts one immutable artifact and must never replace an existing identity. */
  insert(artifact: ExecutionArtifact): Promise<void>;
  /** Returns Task artifact history from oldest to newest. */
  listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]>;
  /** Returns at most `limit` newest artifacts, still ordered from oldest to newest. */
  listRecentByTaskId(taskId: string, limit: number): Promise<readonly ExecutionArtifact[]>;
  /** Reads content-free review evidence only when the full history fits the admission limit. */
  readReviewEvidenceByTaskId(
    taskId: string,
    limit: number,
  ): Promise<TaskReviewArtifactEvidenceSnapshot>;
}

export interface PtyTerminalSize {
  readonly columns: number;
  readonly rows: number;
}

export interface PtyLaunchSpec {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  /** The complete environment passed to the child process. */
  readonly environment: Readonly<Record<string, string>>;
  readonly initialSize: PtyTerminalSize;
}

export type PtyRuntimeOperation =
  'spawn' | 'write' | 'resize' | 'runtime' | 'terminate' | 'cleanup';

export type PtyRuntimeFailureReason =
  | 'INVALID_EXECUTABLE'
  | 'INVALID_ARGUMENT'
  | 'INVALID_WORKING_DIRECTORY'
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_TERMINAL_SIZE'
  | 'INVALID_INPUT'
  | 'NOT_RUNNING'
  | 'UNSUPPORTED_PLATFORM'
  | 'CONPTY_UNAVAILABLE'
  | 'RUNTIME_FAILURE';

export type PtyRuntimeEvent =
  | {
      /** The runtime accepted the launch and its listeners are active; target startup may still fail asynchronously. */
      readonly kind: 'started';
      readonly sequence: number;
    }
  | {
      readonly data: string;
      readonly kind: 'output';
      readonly sequence: number;
    }
  | {
      readonly kind: 'failed';
      readonly operation: PtyRuntimeOperation;
      readonly reason: PtyRuntimeFailureReason;
      readonly sequence: number;
    }
  | {
      readonly exitCode: number;
      readonly kind: 'exited';
      readonly sequence: number;
      readonly signal?: number;
    };

export type PtyRuntimeEventSink = (event: PtyRuntimeEvent) => void;

export interface PtyHandle {
  write(input: string): Promise<void>;
  resize(size: PtyTerminalSize): Promise<void>;
  /** Requests process termination. Calling this more than once is safe. */
  terminate(): Promise<void>;
  /** Terminates when needed and releases owned resources. Calling this more than once is safe. */
  dispose(): Promise<void>;
}

export interface PtyRuntime {
  /**
   * Opens a terminal process and reports its runtime lifecycle without changing Task state.
   * Event sequence numbers are strictly increasing for the returned handle.
   */
  open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle>;
}

export interface QualityGateCatalog {
  /** Resolves a trusted configured gate; callers select only the stable id. */
  findById(id: string): Promise<QualityGate | undefined>;
}

export interface QualityGateRunRepository {
  findById(id: string): Promise<QualityGateRun | undefined>;
  /** Inserts one RUNNING evidence record and must never replace an existing run. */
  insert(run: QualityGateRun): Promise<void>;
  /** Finalizes exactly one RUNNING record using compare-and-set semantics. */
  finalize(run: QualityGateRun, expectedStatus: 'RUNNING'): Promise<void>;
  /** Returns every run for the Task from oldest to newest. */
  listByTaskId(taskId: string): Promise<readonly QualityGateRun[]>;
  /** Returns at most `limit` newest runs, still ordered from oldest to newest. */
  listRecentByTaskId(taskId: string, limit: number): Promise<readonly QualityGateRun[]>;
  /** Reads output/command/path-free review evidence only when history fits the admission limit. */
  readReviewEvidenceByTaskId(
    taskId: string,
    limit: number,
  ): Promise<TaskReviewQualityGateEvidenceSnapshot>;
}

export interface TaskReviewCodeInspector {
  /** Captures an exact, content-sensitive, read-only snapshot of a verified Task Worktree. */
  inspect(worktree: TaskWorktree): Promise<TaskReviewCodeState>;
}

export interface TaskReviewSessionRevision {
  readonly historySequence: number;
  readonly id: string;
}

export interface TaskReviewRepository {
  findById(id: string): Promise<TaskReview | undefined>;
  /** Returns immutable Review attempts from oldest to newest. */
  listByTaskId(taskId: string): Promise<readonly TaskReview[]>;
  /** Returns at most `limit` newest attempts, still ordered from oldest to newest. */
  listRecentByTaskId(taskId: string, limit: number): Promise<readonly TaskReview[]>;
  /** Atomically inserts a PENDING Review only if the captured Session history is still exact. */
  begin(
    review: TaskReview,
    expectedTaskPhase: 'REVIEW' | 'RUNNING',
    nextTask: Task,
    expectedSessionRevisions: readonly TaskReviewSessionRevision[],
  ): Promise<void>;
  /** Atomically finalizes a PENDING Review and applies the explicit user decision. */
  decide(
    review: TaskReview,
    expectedStatus: 'PENDING',
    expectedTaskPhase: 'REVIEW',
    nextTask: Task,
  ): Promise<void>;
}

export interface QualityGateProcessRequest {
  readonly arguments: readonly string[];
  /** Complete environment for the child process; never persisted by the runner. */
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly maxOutputBytes: number;
  readonly redactValues: readonly string[];
  readonly timeoutMs: number;
  readonly workingDirectory: string;
}

export type QualityGateProcessResult =
  | {
      readonly exitCode: number;
      readonly kind: 'exited';
      readonly output: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'timed-out';
      readonly output: string;
      readonly terminationFailed: boolean;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'launch-error';
      readonly output: '';
      readonly reason: 'EXECUTABLE_NOT_FOUND' | 'INVALID_REQUEST' | 'SPAWN_FAILED';
      readonly truncated: false;
    }
  | {
      readonly kind: 'infrastructure-error';
      readonly output: string;
      readonly reason: 'PROCESS_PROTOCOL_ERROR' | 'TERMINATION_FAILED';
      readonly truncated: boolean;
    };

export interface QualityGateProcessRunner {
  run(request: QualityGateProcessRequest): Promise<QualityGateProcessResult>;
}

export type GitHead =
  | {
      readonly branchName: string;
      readonly commitId: string;
      readonly kind: 'attached';
    }
  | {
      readonly commitId: string;
      readonly kind: 'detached';
    }
  | {
      readonly branchName: string;
      readonly kind: 'unborn';
    };

export interface GitBaseBranch {
  readonly name: string;
  readonly refName: string;
  readonly source: 'current-branch' | 'local-main' | 'local-master' | 'remote-head';
}

export interface GitWorkingTreeStatus {
  readonly conflictedPaths: readonly string[];
  readonly isDirty: boolean;
  readonly stagedPaths: readonly string[];
  readonly unstagedPaths: readonly string[];
  readonly untrackedPaths: readonly string[];
}

export interface GitRepositorySnapshot {
  readonly head: GitHead;
  readonly rootPath: string;
  readonly status: GitWorkingTreeStatus;
  readonly suggestedBaseBranch: GitBaseBranch | undefined;
}

export type GitRepositoryInspection =
  | {
      readonly kind: 'not-working-tree';
    }
  | {
      readonly kind: 'repository';
      readonly repository: GitRepositorySnapshot;
    };

export interface GitRepositoryInspector {
  inspect(path: string): Promise<GitRepositoryInspection>;
}

export interface DiscoveredProject {
  readonly id: string;
  readonly name: string;
  readonly pathIdentity: string;
  readonly rootPath: string;
}

export interface LocalProject extends Project {
  readonly rootPath: string;
}

export interface LocalProjectLocator {
  findLocalById(id: string): Promise<LocalProject | undefined>;
}

export type TaskWorktreeLifecycleState = 'PRESENT' | 'PROVISIONING' | 'REMOVED' | 'REMOVING';

export interface TaskWorktree {
  readonly baseCommitId: string;
  readonly baseRefName: string;
  readonly branchName: string;
  readonly pathIdentity: string;
  readonly repositoryRootPath: string;
  readonly taskId: string;
  readonly worktreePath: string;
}

export interface TaskWorktreeRecord extends TaskWorktree {
  readonly lifecycleState: TaskWorktreeLifecycleState;
}

export interface TaskWorktreeStatus extends GitWorkingTreeStatus {
  readonly ignoredPaths: readonly string[];
}

export type TaskWorktreeInspection =
  | {
      readonly kind: 'missing';
      readonly worktree: TaskWorktree;
    }
  | {
      readonly kind: 'stale-registration';
      readonly recoveryPath: string;
      readonly status: TaskWorktreeStatus;
      readonly worktree: TaskWorktree;
    }
  | {
      /** Attached HEAD observed in the verified Worktree at inspection time. */
      readonly headCommitId: string;
      readonly kind: 'present';
      readonly status: TaskWorktreeStatus;
      readonly worktree: TaskWorktree;
    };

export interface InspectGitTaskWorktreeInput {
  readonly recordedWorktree?: TaskWorktreeRecord;
  readonly repositoryRootPath: string;
  readonly taskId: string;
}

export interface TaskWorktreeEnsureResult {
  readonly kind: 'created' | 'reused';
  readonly status: TaskWorktreeStatus;
  readonly worktree: TaskWorktree;
}

export interface TaskWorktreeCleanupResult {
  readonly kind: 'already-missing' | 'removed';
  readonly worktree: TaskWorktree;
}

export interface GitTaskWorktreeLifecycle {
  /** The caller must ensure no process or session can write to this Worktree during cleanup. */
  cleanup(worktree: TaskWorktree): Promise<TaskWorktreeCleanupResult>;
  ensure(worktree: TaskWorktree): Promise<TaskWorktreeEnsureResult>;
  inspect(input: InspectGitTaskWorktreeInput): Promise<TaskWorktreeInspection>;
}

export interface TaskWorktreeRepository {
  findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined>;
  insertReservation(worktree: TaskWorktree): Promise<TaskWorktreeRecord>;
  transitionState(
    taskId: string,
    expectedState: TaskWorktreeLifecycleState,
    nextState: TaskWorktreeLifecycleState,
  ): Promise<TaskWorktreeRecord>;
}

export interface RecordProjectOpenInput {
  readonly pathIdentity: string;
  readonly project: Project;
  readonly rootPath: string;
}

export interface ProjectDiscovery {
  discover(path: string): Promise<DiscoveredProject>;
}

export interface ProjectCatalog {
  /** Atomically inserts a new Project or records a reopen of the same path identity. */
  recordOpen(input: RecordProjectOpenInput): Promise<LocalProject>;
  /** Returns local Projects from most recently opened to least recently opened. */
  listRecent(): Promise<readonly LocalProject[]>;
}

export interface ProjectRepository {
  findById(id: string): Promise<Project | undefined>;
  /** Inserts a new Project and must not replace an existing identity. */
  insert(project: Project): Promise<void>;
}

export interface TaskRepository {
  findById(id: string): Promise<Task | undefined>;
  /** Inserts a new Task and must not replace an existing identity. */
  insert(task: Task): Promise<void>;
  /** Replaces an existing Task only while its persisted phase still matches the caller's read. */
  update(task: Task, expectedPhase: Task['phase']): Promise<void>;
}

export interface TaskCatalog {
  listByProjectId(projectId: string): Promise<readonly Task[]>;
}
