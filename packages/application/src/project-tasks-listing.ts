import type { Task } from '@agentterm/domain';

import { EntityNotFoundError } from './errors';
import type { ProjectRepository, TaskCatalog } from './ports';

export async function listProjectTasks(
  projectId: string,
  projects: ProjectRepository,
  tasks: TaskCatalog,
): Promise<readonly Task[]> {
  const project = await projects.findById(projectId);
  if (project === undefined) {
    throw new EntityNotFoundError('Project', projectId);
  }
  return Object.freeze([...(await tasks.listByProjectId(projectId))]);
}
