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
