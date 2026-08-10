import {
  createProject as createDomainProject,
  type CreateProjectInput,
  type Project,
} from '@agentterm/domain';

import { EntityAlreadyExistsError } from './errors';
import type { ProjectRepository } from './ports';

export async function createProject(
  input: CreateProjectInput,
  projects: ProjectRepository,
): Promise<Project> {
  const project = createDomainProject(input);

  if ((await projects.findById(project.id)) !== undefined) {
    throw new EntityAlreadyExistsError('Project', project.id);
  }

  await projects.insert(project);
  return project;
}
