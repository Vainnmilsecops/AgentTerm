export interface Project {
  readonly id: string;
  readonly name: string;
}

export interface CreateProjectInput {
  readonly id: string;
  readonly name: string;
}

export function createProject(input: CreateProjectInput): Project {
  assertNonBlank(input.id, 'Project id');
  assertNonBlank(input.name, 'Project name');

  return Object.freeze({ ...input });
}

function assertNonBlank(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }
}
