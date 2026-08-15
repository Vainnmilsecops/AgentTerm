import type {
  ApplicationSettings,
  AgentSession,
  ExecutionArtifact,
  Project,
  QualityGate,
  QualityGateRun,
  Task,
  TaskDependency,
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

export interface AgentConfigurationInspector {
  inspect(input: {
    readonly agentId: string;
    readonly configuredExecutablePath?: string;
  }): Promise<AgentAvailability>;
}

export interface ApplicationSettingsRepository {
  get(): Promise<ApplicationSettings>;
  /** Atomically replaces the singleton settings row when its revision matches. */
  update(settings: ApplicationSettings, expectedRevision: number): Promise<void>;
}

export interface AgentSessionRepository {
  findById(id: string): Promise<AgentSession | undefined>;
  /** Inserts one new attempt and must never replace history or admit a second active attempt for its Task. */
  insert(session: AgentSession, expectedTaskPhase?: 'PLANNING' | 'RUNNING'): Promise<void>;
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
  insert(artifact: ExecutionArtifact, expectedTaskPhase?: Task['phase']): Promise<void>;
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

export interface TaskPlanningArtifactRepository extends ExecutionArtifactRepository {
  /** Returns the newest immutable artifact of this kind for exact readiness decisions. */
  findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined>;
}

export interface TaskPlanningRepository {
  /** Atomically rechecks exact Plan/session evidence and moves PLANNING to RUNNING. */
  acceptPlan(
    plan: ExecutionArtifact,
    nextTask: Task,
    expectedSessionRevisions: readonly TaskPlanningSessionRevision[],
  ): Promise<void>;
}

export interface TaskPlanningSessionRevision {
  readonly historySequence: number;
  readonly id: string;
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
  /** Lists trusted configured gates; Presentation receives only safe projections. */
  list(): Promise<readonly QualityGate[]>;
  /** Registers a trusted gate; validation belongs to the use case. */
  register(gate: QualityGate): Promise<void>;
  /** Removes a trusted gate by id; returns false when nothing matched. */
  unregister(id: string): Promise<boolean>;
}

/**
 * Single trusted Quality Gate configuration file exchanged by Composition.
 * Implementations own validation, parsing, and trust-root enforcement; Application
 * and Presentation only ever hold the validated view record returned by load.
 */
export interface QualityGateConfiguration {
  readonly gates: readonly QualityGate[];
  readonly path: string;
  readonly revision: string;
}

/**
 * Reason a {@link QualityGateConfigurator} refuses a path. The contract surfaces
 * the structured failure so callers can map it to precise IPC errors.
 */
export type QualityGateConfiguratorFailure =
  | 'INVALID_FORMAT'
  | 'INVALID_GATE'
  | 'PATH_NOT_TRUSTED'
  | 'PATH_UNREADABLE'
  | 'PATH_UNWRITABLE';

export interface QualityGateConfiguratorResult<T> {
  readonly failure: QualityGateConfiguratorFailure | undefined;
  readonly value: T | undefined;
}

export interface QualityGateConfigurator {
  /** Returns the validated configuration file; failures yield a structured error. */
  load(input: { readonly path: string }): Promise<QualityGateConfiguratorResult<QualityGateConfiguration>>;
  /** Persists the validated configuration atomically; failures yield a structured error. */
  save(input: {
    readonly configuration: QualityGateConfiguration;
    readonly path: string;
  }): Promise<QualityGateConfiguratorResult<QualityGateConfiguration>>;
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

export type TaskChangeArea = 'COMMITTED' | 'CONFLICTED' | 'STAGED' | 'UNSTAGED' | 'UNTRACKED';

export type TaskFileChangeKind =
  'ADDED' | 'COPIED' | 'DELETED' | 'MODIFIED' | 'RENAMED' | 'UNMERGED' | 'UNTRACKED';

export interface TaskFileChange {
  readonly area: TaskChangeArea;
  readonly kind: TaskFileChangeKind;
  readonly path: string;
  readonly previousPath?: string;
}

export interface TaskChangeSet {
  readonly files: readonly TaskFileChange[];
  readonly totalFiles: number;
  readonly truncated: boolean;
}

export interface TaskFileDiffRequest {
  readonly area: TaskChangeArea;
  readonly path: string;
  readonly previousPath?: string;
}

export interface TaskFileDiff extends TaskFileChange {
  readonly additions: number | undefined;
  readonly binary: boolean | undefined;
  readonly deletions: number | undefined;
  readonly omittedReason?: 'BINARY' | 'TOO_LARGE' | 'UNSUPPORTED';
  readonly patch?:
    | {
        readonly text: string;
        readonly truncated: false;
      }
    | undefined;
}

export interface TaskChangeInspector {
  /** Reads a bounded, deterministic list from the exact verified primary Task Worktree. */
  listChanges(worktree: TaskWorktreeRecord): Promise<TaskChangeSet>;
  /** Reads one bounded patch only when the requested identity is still a current change. */
  getFileDiff(worktree: TaskWorktreeRecord, request: TaskFileDiffRequest): Promise<TaskFileDiff>;
}

export type PullRequestStatus = 'CLOSED' | 'MERGED' | 'OPEN';

export type PullRequestReviewState =
  'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'NONE' | 'UNKNOWN';

export type PullRequestCheckState = 'FAILURE' | 'NONE' | 'PENDING' | 'SUCCESS' | 'UNKNOWN';

export interface PullRequestCheckSummary {
  readonly failureCount: number;
  readonly pendingCount: number;
  readonly state: PullRequestCheckState;
  readonly successCount: number;
  readonly totalCount: number;
}

export interface TaskPullRequest {
  readonly baseBranch: string;
  readonly checks: PullRequestCheckSummary;
  readonly createdAt: number;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headCommitId: string;
  /** Local observation time for the last complete, successful GitHub metadata snapshot. */
  readonly lastSyncedAt: number | undefined;
  readonly number: number;
  readonly provider: 'github';
  readonly repositoryName: string;
  readonly repositoryOwner: string;
  readonly reviewState: PullRequestReviewState;
  readonly status: PullRequestStatus;
  readonly taskId: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly url: string;
}

export type PullRequestBranchReadinessFailure =
  | 'BRANCH_MISMATCH'
  | 'DETACHED_HEAD'
  | 'GITHUB_REMOTE_NOT_FOUND'
  | 'INSPECTION_FAILED'
  | 'INVALID_BASE_BRANCH'
  | 'NO_COMMITS_AHEAD'
  | 'UNCOMMITTED_CHANGES'
  | 'WORKTREE_NOT_READY';

export type PullRequestBranchInspection =
  | {
      readonly kind: 'blocked';
      readonly reason: PullRequestBranchReadinessFailure;
    }
  | {
      readonly baseBranch: string;
      readonly githubAuthenticationAvailable: boolean;
      readonly githubCliAvailable: boolean;
      readonly headBranch: string;
      readonly headCommitId: string;
      readonly kind: 'ready';
      readonly provider: 'github';
      readonly pullRequest: TaskPullRequest | undefined;
      readonly remoteHeadCommitId: string | undefined;
      readonly remoteName: string;
      readonly repositoryName: string;
      readonly repositoryOwner: string;
    };

export interface CreatePullRequestRequest {
  readonly body: string;
  readonly title: string;
}

export interface PullRequestIntegration {
  /** Inspects only the exact persisted primary Worktree and performs no mutation. */
  inspect(worktree: TaskWorktreeRecord): Promise<PullRequestBranchInspection>;
  /** Performs a normal non-force push of the exact inspected Task branch. */
  push(worktree: TaskWorktreeRecord): Promise<PullRequestBranchInspection>;
  /** Returns an existing suitable PR or creates one without reopening or duplicating it. */
  createOrRefresh(
    worktree: TaskWorktreeRecord,
    request: CreatePullRequestRequest,
  ): Promise<TaskPullRequest>;
  /** Reads one persisted PR identity from GitHub without mutating remote state. */
  refresh(pullRequest: TaskPullRequest): Promise<TaskPullRequest | undefined>;
}

export interface PullRequestRepository {
  /** Returns stored PR metadata for the Task from oldest to newest update time. */
  listByTaskId(taskId: string): Promise<readonly TaskPullRequest[]>;
  /** Inserts or refreshes metadata for the same Task/repository/base/head identity. */
  record(pullRequest: TaskPullRequest): Promise<void>;
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

export interface TaskDependencyRepository {
  /** Atomically inserts only a same-Project, unique, acyclic dependency. */
  add(dependency: TaskDependency): Promise<void>;
  listByProjectId(projectId: string): Promise<readonly TaskDependency[]>;
  listByTaskId(taskId: string): Promise<readonly TaskDependency[]>;
  remove(dependency: TaskDependency): Promise<boolean>;
}
