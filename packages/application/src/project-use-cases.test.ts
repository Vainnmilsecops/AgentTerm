import { describe, expect, it } from 'vitest';

import type { Project } from '@agentterm/domain';

import { createProject, type ProjectRepository } from './index';

class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  public async findById(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  public async insert(project: Project): Promise<void> {
    if (this.projects.has(project.id)) {
      throw new Error(`Project ${project.id} already exists in the fake repository.`);
    }

    this.projects.set(project.id, project);
  }
}

describe('createProject', () => {
  it('creates and persists a valid project', async () => {
    const projects = new InMemoryProjectRepository();

    const project = await createProject({ id: 'project-1', name: 'AgentTerm' }, projects);

    expect(project).toEqual({ id: 'project-1', name: 'AgentTerm' });
    await expect(projects.findById('project-1')).resolves.toEqual(project);
  });

  it('rejects a duplicate project id without replacing the existing project', async () => {
    const projects = new InMemoryProjectRepository();
    await createProject({ id: 'project-1', name: 'Existing project' }, projects);

    const duplicate = createProject({ id: 'project-1', name: 'Replacement' }, projects);

    await expect(duplicate).rejects.toMatchObject({
      name: 'EntityAlreadyExistsError',
      entity: 'Project',
      id: 'project-1',
    });
    await expect(projects.findById('project-1')).resolves.toEqual({
      id: 'project-1',
      name: 'Existing project',
    });
  });
});
