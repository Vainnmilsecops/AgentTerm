import { describe, expect, it } from 'vitest';

import {
  ProjectOpenError,
  listRecentProjects,
  openProject,
  type DiscoveredProject,
  type LocalProject,
  type ProjectCatalog,
  type ProjectDiscovery,
  type RecordProjectOpenInput,
} from './index';

class StubProjectDiscovery implements ProjectDiscovery {
  public constructor(
    private readonly discoveries: Readonly<Record<string, DiscoveredProject | ProjectOpenError>>,
  ) {}

  public async discover(path: string): Promise<DiscoveredProject> {
    const discovery = this.discoveries[path];

    if (discovery === undefined) {
      throw new Error(`Unexpected project path in test: ${path}`);
    }

    if (discovery instanceof ProjectOpenError) {
      throw discovery;
    }

    return discovery;
  }
}

class InMemoryProjectCatalog implements ProjectCatalog {
  private readonly identities = new Map<string, string>();
  private readonly projects = new Map<string, LocalProject>();
  private recentProjectIds: string[] = [];

  public async recordOpen(input: RecordProjectOpenInput): Promise<LocalProject> {
    const existingId = this.identities.get(input.pathIdentity);
    const existing = existingId === undefined ? undefined : this.projects.get(existingId);
    const localProject = existing ?? Object.freeze({ ...input.project, rootPath: input.rootPath });

    this.identities.set(input.pathIdentity, localProject.id);
    this.projects.set(localProject.id, localProject);
    this.recentProjectIds = [
      localProject.id,
      ...this.recentProjectIds.filter((id) => id !== localProject.id),
    ];

    return localProject;
  }

  public async listRecent(): Promise<readonly LocalProject[]> {
    return this.recentProjectIds.map((id) => {
      const project = this.projects.get(id);

      if (project === undefined) {
        throw new Error(`Missing Project ${id} in fake catalog.`);
      }

      return project;
    });
  }
}

function discoveredProject(overrides: Partial<DiscoveredProject> = {}): DiscoveredProject {
  return {
    id: 'project-repository-1',
    name: 'AgentTerm',
    pathIdentity: 'win32:d:\\core\\agentterm',
    rootPath: 'D:\\Core\\AgentTerm',
    ...overrides,
  };
}

describe('openProject', () => {
  it('opens a discovered Git project and records it in the project catalog', async () => {
    const discovery = new StubProjectDiscovery({
      'D:\\Core\\AgentTerm': discoveredProject(),
    });
    const projects = new InMemoryProjectCatalog();

    const project = await openProject({ path: 'D:\\Core\\AgentTerm' }, discovery, projects);

    expect(project).toEqual({
      id: 'project-repository-1',
      name: 'AgentTerm',
      rootPath: 'D:\\Core\\AgentTerm',
    });
    await expect(listRecentProjects(projects)).resolves.toEqual([project]);
  });

  it('reopens the same repository without duplicating it and moves it to most recent', async () => {
    const firstProject = discoveredProject();
    const secondProject = discoveredProject({
      id: 'project-repository-2',
      name: 'Other',
      pathIdentity: 'win32:d:\\core\\other',
      rootPath: 'D:\\Core\\Other',
    });
    const discovery = new StubProjectDiscovery({
      'D:\\Core\\AgentTerm': firstProject,
      'D:\\Core\\AgentTerm\\packages': firstProject,
      'D:\\Core\\Other': secondProject,
    });
    const projects = new InMemoryProjectCatalog();

    const firstOpen = await openProject({ path: 'D:\\Core\\AgentTerm' }, discovery, projects);
    const secondOpen = await openProject({ path: 'D:\\Core\\Other' }, discovery, projects);
    const reopened = await openProject(
      { path: 'D:\\Core\\AgentTerm\\packages' },
      discovery,
      projects,
    );

    expect(reopened).toEqual(firstOpen);
    await expect(listRecentProjects(projects)).resolves.toEqual([firstOpen, secondOpen]);
  });

  it('does not record a project when discovery rejects the path', async () => {
    const error = new ProjectOpenError('NOT_GIT_REPOSITORY', 'D:\\NotARepository');
    const discovery = new StubProjectDiscovery({ 'D:\\NotARepository': error });
    const projects = new InMemoryProjectCatalog();

    const result = openProject({ path: 'D:\\NotARepository' }, discovery, projects);

    await expect(result).rejects.toBe(error);
    await expect(listRecentProjects(projects)).resolves.toEqual([]);
  });

  it('rejects malformed discovery data before persistence', async () => {
    const discovery = new StubProjectDiscovery({
      'D:\\Core\\AgentTerm': discoveredProject({ rootPath: '   ' }),
    });
    const projects = new InMemoryProjectCatalog();

    const result = openProject({ path: 'D:\\Core\\AgentTerm' }, discovery, projects);

    await expect(result).rejects.toThrow(TypeError);
    await expect(listRecentProjects(projects)).resolves.toEqual([]);
  });
});
