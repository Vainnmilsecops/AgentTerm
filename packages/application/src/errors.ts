export type EntityKind = 'Project' | 'Task';

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
