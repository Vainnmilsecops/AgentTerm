import { mkdtempSync, rmSync } from 'node:fs';
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
});
