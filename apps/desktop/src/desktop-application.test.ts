import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createProductionDesktopApplication } from './desktop-application';

describe('production desktop Application composition', () => {
  it('loads persisted workspace/settings through Application use cases without renderer infrastructure access', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentterm-desktop-application-'));
    const application = await createProductionDesktopApplication({
      clock: () => 1_800_000_000_000,
      dataDirectory: directory,
      environment: { PATH: process.env.PATH ?? '' },
    });

    try {
      const [workspace, settings] = await Promise.all([
        application.loadWorkspace(),
        application.loadSettings(),
      ]);

      expect(workspace.projects).toEqual([]);
      expect(workspace.agents.map(({ id }) => id)).toEqual(['codex', 'claude', 'gemini']);
      expect(settings.settings).toMatchObject({
        defaultAgentId: 'codex',
        revision: 0,
        schemaVersion: 1,
      });
      await expect(
        application.startTaskExecution({ agentId: 'codex', taskId: 'missing-task' }),
      ).rejects.toMatchObject({ name: 'EntityNotFoundError' });
    } finally {
      application.dispose();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('opens a real Git Project, creates a Task, and enters PLANNING only after explicit acceptance', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentterm-desktop-onboarding-'));
    const repositoryPath = join(directory, 'Vietnamese Project');
    mkdirSync(repositoryPath);
    execFileSync('git', ['init', '--quiet', repositoryPath], { windowsHide: true });
    const application = await createProductionDesktopApplication({
      clock: () => 1_800_000_000_000,
      dataDirectory: join(directory, 'data'),
      environment: { PATH: process.env.PATH ?? '' },
    });

    try {
      await application.openProject({ path: repositoryPath });
      const opened = await application.loadWorkspace();
      const project = opened.projects[0]?.project;
      expect(project).toMatchObject({ name: 'Vietnamese Project' });
      expect(project).not.toHaveProperty('rootPath');

      const created = await application.createTask({
        projectId: project!.id,
        title: 'Kiểm thử coding agent',
      });
      const backlog = await application.loadWorkspace();
      expect(backlog.projects[0]?.tasks[0]).toMatchObject({
        canBeginPlanning: true,
        task: { id: created.taskId, phase: 'BACKLOG', title: 'Kiểm thử coding agent' },
      });

      await application.beginTaskPlanning({ taskId: created.taskId });
      const planning = await application.loadWorkspace();
      expect(planning.projects[0]?.tasks[0]).toMatchObject({
        canBeginPlanning: false,
        canStartPlanning: true,
        task: { id: created.taskId, phase: 'PLANNING' },
      });
    } finally {
      application.dispose();
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);
});
