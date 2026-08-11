import type { Project, Task } from '@agentterm/domain';

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
  /** Replaces an existing Task and must not create a missing identity. */
  update(task: Task): Promise<void>;
}
