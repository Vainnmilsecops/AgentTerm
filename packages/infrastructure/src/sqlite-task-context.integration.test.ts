import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAgentSession, createProject, createTask } from '@agentterm/domain';
import { openSqlitePersistence } from './index';
import { importTaskContext } from '@agentterm/application';
import { ManagedTaskContextStore } from './task-context-store';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

describe('SQLite task context', () => {
  it('imports through the application into real private files and SQLite without persisting payloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentterm-context-flow-'));
    const db = openSqlitePersistence(join(root, 'state.db'));
    try {
      await db.projects.insert(createProject({ id: 'project', name: 'Project' }));
      await db.tasks.insert(createTask({ id: 'task', projectId: 'project', title: 'Task' }));
      await db.sessions.insert(
        createAgentSession({ id: 'session', taskId: 'task', agentId: 'test', createdAt: 1 }),
        'BACKLOG',
      );
      const bytes = Buffer.from('Xin chào 👋');
      const result = await importTaskContext(
        {
          taskId: 'task',
          sessionId: 'session',
          files: [{ name: 'note.txt', mime: 'text/plain', bytes }],
        },
        {
          tasks: db.tasks,
          sessions: db.sessions,
          repository: db.contextAttachments,
          store: new ManagedTaskContextStore(join(root, 'context')),
          clock: () => 123,
        },
      );
      expect(await db.contextAttachments.listByTaskId('task')).toEqual(result);
      expect(
        readFileSync(
          join(root, 'context', createHash('sha256').update('task').digest('hex'), result[0]!.id),
        ),
      ).toEqual(bytes);
      expect(JSON.stringify(result)).not.toContain('Xin chào');
      expect(JSON.stringify(result)).not.toContain(root);
      expect((await db.sessions.findById('session'))?.history).toEqual([
        expect.objectContaining({ kind: 'START_REQUESTED', occurredAt: 1 }),
      ]);
      expect((await db.tasks.findById('task'))?.phase).toBe('BACKLOG');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('persists metadata on reopen, rejects cross-task sessions and prevents mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentterm-context-db-'));
    const path = join(root, 'state.db');
    const item = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      taskId: 'task',
      sessionId: 'session',
      name: 'note.txt',
      mime: 'text/plain',
      size: 3,
      digest: 'a'.repeat(64),
      createdAt: 1,
    };
    let db = openSqlitePersistence(path);
    try {
      await db.projects.insert(createProject({ id: 'project', name: 'Project' }));
      await db.tasks.insert(createTask({ id: 'task', projectId: 'project', title: 'Task' }));
      await db.tasks.insert(createTask({ id: 'other', projectId: 'project', title: 'Other' }));
      await db.sessions.insert(
        createAgentSession({ id: 'session', taskId: 'task', agentId: 'test', createdAt: 1 }),
        'BACKLOG',
      );
      await db.contextAttachments.insertBatch([item]);
      await expect(
        db.contextAttachments.insertBatch([
          { ...item, id: '550e8400-e29b-41d4-a716-446655440002' },
          { ...item, id: '550e8400-e29b-41d4-a716-446655440003', sessionId: 'missing' },
        ]),
      ).rejects.toThrow();
      expect(await db.contextAttachments.listByTaskId('task')).toEqual([item]);
      await expect(
        db.contextAttachments.insertBatch([
          { ...item, id: '550e8400-e29b-41d4-a716-446655440001', taskId: 'other' },
        ]),
      ).rejects.toThrow();
      db.close();
      db = openSqlitePersistence(path);
      expect(await db.contextAttachments.listByTaskId('task')).toEqual([item]);
      const raw = new DatabaseSync(path);
      try {
        expect(() =>
          raw.exec("UPDATE task_context_attachments SET name = 'changed.txt'"),
        ).toThrow();
        expect(() => raw.exec('DELETE FROM task_context_attachments')).toThrow();
      } finally {
        raw.close();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
