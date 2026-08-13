import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfiguredAgentCatalog,
  loadAgentWorkspace,
  restoreAgentSessionsAfterRestart,
  type AgentAdapter,
} from '@agentterm/application';
import {
  createAgentSession,
  createProject,
  createTask,
  recordAgentSessionEvent,
  TaskPhase,
  transitionTask,
} from '@agentterm/domain';

import { openSqlitePersistence } from './index';

const createdAt = 1_800_000_000_000;
const codexAdapter: AgentAdapter = {
  identity: { displayName: 'Codex', id: 'codex' },
  inspect: async () => ({
    capabilities: ['SESSION_RESUME'],
    executablePath: 'D:\\private\\codex.exe',
    kind: 'available',
  }),
  buildLaunchCommand: async () => {
    throw new Error('buildLaunchCommand is not used during workspace restore');
  },
};

describe('Agent Session startup restore with SQLite', () => {
  it('reopens active history, records lost ownership, and exposes FAILED without completing Task', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentterm-session-restore-'));
    const databasePath = join(directory, 'agentterm.db');
    const initial = openSqlitePersistence(databasePath);

    try {
      const project = createProject({
        id: 'project-1',
        name: 'D\u1ef1 \u00e1n kh\u00f4i ph\u1ee5c',
      });
      await initial.projects.recordOpen({
        pathIdentity: 'project-identity-1',
        project,
        rootPath: 'D:\\Repositories\\D\u1ef1 \u00e1n kh\u00f4i ph\u1ee5c',
      });
      const runningTask = transitionTask(
        transitionTask(
          createTask({
            id: 'task-1',
            projectId: project.id,
            title: 'Kh\u00f4i ph\u1ee5c phi\u00ean',
          }),
          TaskPhase.PLANNING,
        ),
        TaskPhase.RUNNING,
      );
      await initial.tasks.insert(runningTask);

      const olderStarting = createAgentSession({
        agentId: 'codex',
        createdAt,
        id: 'session-old',
        taskId: runningTask.id,
      });
      const olderExited = recordAgentSessionEvent(olderStarting, {
        exitCode: 0,
        kind: 'PROCESS_EXITED',
        occurredAt: createdAt + 1,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 1,
      });
      const activeStarting = createAgentSession({
        agentId: 'codex',
        createdAt: createdAt + 2,
        id: 'session-active',
        taskId: runningTask.id,
      });
      const activeWorking = recordAgentSessionEvent(activeStarting, {
        kind: 'STATUS_REPORTED',
        occurredAt: createdAt + 3,
        runtimeSequence: 1,
        source: 'RUNTIME',
        status: 'WORKING',
      });
      await initial.sessions.insert(olderStarting);
      await initial.sessions.append(olderExited, 1);
      await initial.sessions.insert(activeStarting);
      await initial.sessions.append(activeWorking, 1);
    } finally {
      initial.close();
    }

    try {
      const reopened = openSqlitePersistence(databasePath);
      try {
        const restored = await restoreAgentSessionsAfterRestart(
          reopened.sessions,
          () => createdAt + 100,
        );
        const workspace = await loadAgentWorkspace(
          reopened.projects,
          reopened.tasks,
          reopened.sessions,
          reopened.artifacts,
          reopened.qualityGateRuns,
          reopened.reviews,
          new ConfiguredAgentCatalog([codexAdapter]),
        );
        const sessions = await reopened.sessions.listByTaskId('task-1');

        expect(restored.reconciledSessions).toMatchObject([
          {
            endedAt: createdAt + 100,
            history: [
              { kind: 'START_REQUESTED' },
              { kind: 'STATUS_REPORTED', status: 'WORKING' },
              {
                code: 'RUNTIME_OWNERSHIP_LOST',
                fatal: true,
                kind: 'RUNTIME_FAILED',
                stage: 'RUNTIME',
                status: 'FAILED',
              },
            ],
            id: 'session-active',
            status: 'FAILED',
          },
        ]);
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toMatchObject({ id: 'session-old', status: 'EXITED' });
        expect(sessions[1]).toMatchObject({ id: 'session-active', status: 'FAILED' });
        expect(workspace.projects[0]?.tasks[0]).toMatchObject({
          activeSession: undefined,
          latestSession: { id: 'session-active', status: 'FAILED' },
          task: { phase: 'RUNNING' },
        });
      } finally {
        reopened.close();
      }

      const reopenedAgain = openSqlitePersistence(databasePath);
      try {
        await expect(
          restoreAgentSessionsAfterRestart(reopenedAgain.sessions, () => createdAt + 200),
        ).resolves.toEqual({ reconciledSessions: [] });
        await expect(reopenedAgain.tasks.findById('task-1')).resolves.toMatchObject({
          phase: 'RUNNING',
        });
        await expect(reopenedAgain.sessions.listByTaskId('task-1')).resolves.toHaveLength(2);
      } finally {
        reopenedAgain.close();
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
