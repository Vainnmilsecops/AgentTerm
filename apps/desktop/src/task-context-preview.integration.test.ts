import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Domain builders are used only to seed the isolated integration-test database.
import { createAgentSession, createProject, createTask } from '../../../packages/domain/src/index';
import { openSqlitePersistence } from '@agentterm/infrastructure';
import { createProductionDesktopApplication } from './desktop-application';

describe('desktop saved context preview composition', () => {
  it('previews imported text after restart without an agent, worktree or metadata changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentterm-preview-desktop-'));
    let app: Awaited<ReturnType<typeof createProductionDesktopApplication>> | undefined;
    try {
      const db = openSqlitePersistence(join(root, 'agentterm.db'));
      try {
        await db.projects.insert(createProject({ id: 'project', name: 'Project' }));
        await db.tasks.insert(createTask({ id: 'task', projectId: 'project', title: 'Task' }));
        await db.tasks.insert(createTask({ id: 'other', projectId: 'project', title: 'Other' }));
        await db.sessions.insert(
          createAgentSession({ id: 'session', taskId: 'task', agentId: 'test', createdAt: 1 }),
          'BACKLOG',
        );
      } finally {
        db.close();
      }
      app = await createProductionDesktopApplication({
        dataDirectory: root,
        environment: { PATH: '' },
      });
      const records = await app.importTaskContext({
        taskId: 'task',
        sessionId: 'session',
        files: [
          {
            name: 'ghi-chú.md',
            mime: 'text/markdown',
            bytes: new TextEncoder().encode('# Xin chào 👋'),
          },
        ],
      });
      app.dispose();
      app = await createProductionDesktopApplication({
        dataDirectory: root,
        environment: { PATH: '' },
      });
      const id = records[0]!.id;
      // Startup recovery has already reconciled the seeded STARTING session.
      // Capture that durable state before preview, rather than attributing startup events to it.
      const before = openSqlitePersistence(join(root, 'agentterm.db'));
      const priorSession = await before.sessions.findById('session');
      before.close();
      expect(await app.previewTaskContext({ taskId: 'task', attachmentId: id })).toEqual({
        attachmentId: id,
        text: '# Xin chào 👋',
      });
      expect(await app.listTaskContext({ taskId: 'task' })).toEqual(records);
      await expect(app.previewTaskContext({ taskId: 'other', attachmentId: id })).rejects.toThrow();
      app.dispose();
      app = undefined;
      const reopened = openSqlitePersistence(join(root, 'agentterm.db'));
      try {
        expect(await reopened.sessions.findById('session')).toEqual(priorSession);
        expect((await reopened.tasks.findById('task'))?.phase).toBe('BACKLOG');
      } finally {
        reopened.close();
      }
    } finally {
      app?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
