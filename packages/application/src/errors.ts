export type EntityKind = 'Project' | 'Task';

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
