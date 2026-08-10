export {
  EntityAlreadyExistsError,
  EntityNotFoundError,
  ProjectOpenError,
  type EntityKind,
  type ProjectOpenFailure,
} from './errors';
export { listRecentProjects, openProject, type OpenProjectInput } from './project-management';
export { createProject } from './project-use-cases';
export type {
  DiscoveredProject,
  LocalProject,
  ProjectCatalog,
  ProjectDiscovery,
  ProjectRepository,
  RecordProjectOpenInput,
  TaskRepository,
} from './ports';
export { createTask, transitionTask, type TransitionTaskInput } from './task-use-cases';
