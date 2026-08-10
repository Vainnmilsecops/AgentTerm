import { createProject as createDomainProject } from '@agentterm/domain';

import type {
  LocalProject,
  ProjectCatalog,
  ProjectDiscovery,
  RecordProjectOpenInput,
} from './ports';

export interface OpenProjectInput {
  readonly path: string;
}

export async function openProject(
  input: OpenProjectInput,
  discovery: ProjectDiscovery,
  projects: ProjectCatalog,
): Promise<LocalProject> {
  const discovered = await discovery.discover(input.path);
  const project = createDomainProject({ id: discovered.id, name: discovered.name });
  const record: RecordProjectOpenInput = {
    pathIdentity: requireNonBlank(discovered.pathIdentity, 'Project path identity'),
    project,
    rootPath: requireNonBlank(discovered.rootPath, 'Project root path'),
  };

  return projects.recordOpen(record);
}

export async function listRecentProjects(
  projects: ProjectCatalog,
): Promise<readonly LocalProject[]> {
  return projects.listRecent();
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be blank.`);
  }

  return value;
}
