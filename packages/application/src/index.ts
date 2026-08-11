export {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  GitRepositoryInspectionError,
  ProjectOpenError,
  TaskWorktreeLifecycleError,
  TaskWorktreeMetadataConflictError,
  TaskWorktreePersistenceError,
  type EntityKind,
  type GitRepositoryInspectionFailure,
  type ProjectOpenFailure,
  type TaskWorktreeLifecycleFailure,
} from './errors';
export { listRecentProjects, openProject, type OpenProjectInput } from './project-management';
export { createProject } from './project-use-cases';
export type {
  DiscoveredProject,
  GitBaseBranch,
  GitHead,
  GitRepositoryInspection,
  GitRepositoryInspector,
  GitRepositorySnapshot,
  GitWorkingTreeStatus,
  GitTaskWorktreeLifecycle,
  InspectGitTaskWorktreeInput,
  LocalProject,
  LocalProjectLocator,
  ProjectCatalog,
  ProjectDiscovery,
  ProjectRepository,
  RecordProjectOpenInput,
  TaskRepository,
  TaskWorktree,
  TaskWorktreeCleanupResult,
  TaskWorktreeEnsureResult,
  TaskWorktreeInspection,
  TaskWorktreeLifecycleState,
  TaskWorktreeRecord,
  TaskWorktreeRepository,
  TaskWorktreeStatus,
} from './ports';
export { createTask, transitionTask, type TransitionTaskInput } from './task-use-cases';
export {
  cleanupTaskWorktree,
  ensureTaskWorktree,
  inspectTaskWorktree,
  type InspectTaskWorktreeResult,
  type TaskWorktreeInput,
} from './task-worktree-use-cases';
