import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { EntityAlreadyExistsError } from '@agentterm/application';
import {
  createAgentSession,
  createProject,
  createTask,
  recordAgentSessionEvent,
  TaskPhase,
} from '@agentterm/domain';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

const createdAt = 1_800_000_000_000;

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-agent-session-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function seedTask(databasePath: string): Promise<void> {
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
    await persistence.tasks.insert(
      createTask({ id: 'task-1', projectId: 'project-1', title: 'Persist sessions' }),
    );
  } finally {
    persistence.close();
  }
}

describe('SQLite Agent Session persistence', () => {
  it('round-trips status history across connections', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      const starting = startingSession('session-1');
      const working = recordAgentSessionEvent(starting, {
        kind: 'STATUS_REPORTED',
        occurredAt: createdAt + 1,
        runtimeSequence: 1,
        source: 'RUNTIME',
        status: 'WORKING',
      });
      const waiting = recordAgentSessionEvent(working, {
        kind: 'STATUS_REPORTED',
        occurredAt: createdAt + 2,
        source: 'APPLICATION',
        status: 'WAITING_INPUT',
      });

      try {
        await persistence.sessions.insert(starting);
        await persistence.sessions.append(working, 1);
        await persistence.sessions.append(waiting, 2);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.sessions.findById('session-1')).resolves.toEqual(waiting);
        await expect(reopened.sessions.listByTaskId('task-1')).resolves.toEqual([waiting]);
        await expect(reopened.tasks.findById('task-1')).resolves.toMatchObject({
          phase: TaskPhase.BACKLOG,
        });
      } finally {
        reopened.close();
      }
    });
  });

  it('preserves every session for a Task in creation order', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const first = startingSession('session-1');
        const firstExited = recordAgentSessionEvent(first, {
          exitCode: 0,
          kind: 'PROCESS_EXITED',
          occurredAt: createdAt + 1,
          reason: 'PROCESS_EXIT',
          runtimeSequence: 1,
        });
        const second = startingSession('session-2');
        await persistence.sessions.insert(first);
        await persistence.sessions.append(firstExited, 1);
        await persistence.sessions.insert(second);

        await expect(persistence.sessions.listByTaskId('task-1')).resolves.toEqual([
          firstExited,
          second,
        ]);
        await expect(
          persistence.sessions.insert({ ...first, agentId: 'replacement' }),
        ).rejects.toBeInstanceOf(EntityAlreadyExistsError);
        await expect(persistence.sessions.listByTaskId('task-1')).resolves.toEqual([
          firstExited,
          second,
        ]);
      } finally {
        persistence.close();
      }
    });
  });

  it('atomically admits only one active Session per Task across connections', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const firstConnection = openSqlitePersistence(databasePath);
      const secondConnection = openSqlitePersistence(databasePath);
      try {
        const results = await Promise.allSettled([
          firstConnection.sessions.insert(startingSession('session-1')),
          secondConnection.sessions.insert(startingSession('session-2')),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        const sessions = await firstConnection.sessions.listByTaskId('task-1');
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ status: 'STARTING', taskId: 'task-1' });
        expect(results.find(({ status }) => status === 'rejected')).toMatchObject({
          reason: { name: 'AgentSessionActiveConflictError', taskId: 'task-1' },
        });
      } finally {
        secondConnection.close();
        firstConnection.close();
      }
    });
  });

  it('uses revision CAS so a stale append cannot overwrite history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const starting = startingSession('session-1');
        const working = recordAgentSessionEvent(starting, {
          kind: 'STATUS_REPORTED',
          occurredAt: createdAt + 1,
          runtimeSequence: 1,
          source: 'RUNTIME',
          status: 'WORKING',
        });
        const staleExit = recordAgentSessionEvent(starting, {
          exitCode: 1,
          kind: 'PROCESS_EXITED',
          occurredAt: createdAt + 2,
          reason: 'PROCESS_EXIT',
          runtimeSequence: 2,
        });

        await persistence.sessions.insert(starting);
        await persistence.sessions.append(working, 1);
        await expect(persistence.sessions.append(staleExit, 1)).rejects.toThrow();
        await expect(persistence.sessions.findById('session-1')).resolves.toEqual(working);
      } finally {
        persistence.close();
      }
    });
  });

  it('allows only one of two concurrent appends from the same revision', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const firstConnection = openSqlitePersistence(databasePath);
      const secondConnection = openSqlitePersistence(databasePath);
      try {
        const starting = startingSession('session-1');
        const working = recordAgentSessionEvent(starting, {
          kind: 'STATUS_REPORTED',
          occurredAt: createdAt + 1,
          runtimeSequence: 1,
          source: 'RUNTIME',
          status: 'WORKING',
        });
        const exited = recordAgentSessionEvent(starting, {
          exitCode: 0,
          kind: 'PROCESS_EXITED',
          occurredAt: createdAt + 1,
          reason: 'PROCESS_EXIT',
          runtimeSequence: 1,
        });
        await firstConnection.sessions.insert(starting);

        const results = await Promise.allSettled([
          firstConnection.sessions.append(working, 1),
          secondConnection.sessions.append(exited, 1),
        ]);

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        const stored = await firstConnection.sessions.findById('session-1');
        expect(stored?.history).toHaveLength(2);
        expect(['WORKING', 'EXITED']).toContain(stored?.status);
      } finally {
        secondConnection.close();
        firstConnection.close();
      }
    });
  });

  it('rejects an append whose immutable identity does not match stored history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const stored = startingSession('session-1');
        const forgedStarting = createAgentSession({
          agentId: 'other-agent',
          createdAt,
          id: 'session-1',
          taskId: 'task-1',
        });
        const forgedWorking = recordAgentSessionEvent(forgedStarting, {
          kind: 'STATUS_REPORTED',
          occurredAt: createdAt + 1,
          runtimeSequence: 1,
          source: 'RUNTIME',
          status: 'WORKING',
        });

        await persistence.sessions.insert(stored);
        await expect(persistence.sessions.append(forgedWorking, 1)).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
        await expect(persistence.sessions.findById('session-1')).resolves.toEqual(stored);
      } finally {
        persistence.close();
      }
    });
  });

  it('round-trips fatal failure plus later exit evidence while retaining FAILED status', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const starting = startingSession('session-1');
        const failed = recordAgentSessionEvent(starting, {
          code: 'RUNTIME_FAILURE',
          fatal: true,
          kind: 'RUNTIME_FAILED',
          occurredAt: createdAt + 1,
          runtimeSequence: 1,
          stage: 'RUNTIME',
        });
        const exitedEvidence = recordAgentSessionEvent(failed, {
          exitCode: -1,
          kind: 'PROCESS_EXITED',
          occurredAt: createdAt + 2,
          reason: 'PROCESS_EXIT',
          runtimeSequence: 2,
        });

        await persistence.sessions.insert(starting);
        await persistence.sessions.append(failed, 1);
        await persistence.sessions.append(exitedEvidence, 2);

        await expect(persistence.sessions.findById('session-1')).resolves.toEqual(exitedEvidence);
      } finally {
        persistence.close();
      }
    });
  });

  it('enforces Task relationship, status, and runtime-sequence constraints', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        const insertSession = database.prepare(
          `INSERT INTO agent_sessions (
             id, task_id, agent_id, ordinal, status, created_at, ended_at, history_sequence
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        expect(() =>
          insertSession.run(
            'missing-task-session',
            'missing',
            'codex',
            1,
            'STARTING',
            createdAt,
            null,
            1,
          ),
        ).toThrow();
        expect(() =>
          insertSession.run('invalid-status', 'task-1', 'codex', 1, 'DONE', createdAt, null, 1),
        ).toThrow();
        insertSession.run('session-1', 'task-1', 'codex', 1, 'STARTING', createdAt, null, 1);

        expect(() =>
          database
            .prepare(
              `INSERT INTO agent_session_events (
               session_id, sequence, kind, status, occurred_at, runtime_sequence,
               source, failure_code, fatal, stage, exit_code, exit_reason, signal
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              'session-1',
              2,
              'PROCESS_EXITED',
              'EXITED',
              createdAt + 1,
              0,
              null,
              null,
              null,
              null,
              0,
              'PROCESS_EXIT',
              null,
            ),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('rejects corrupted event history during mapping', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTask(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.sessions.insert(startingSession('session-1'));
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath);
      try {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database
          .prepare(
            'UPDATE agent_session_events SET status = ? WHERE session_id = ? AND sequence = 1',
          )
          .run('DONE', 'session-1');
      } finally {
        database.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.sessions.findById('session-1')).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
      } finally {
        reopened.close();
      }
    });
  });
});

function startingSession(id: string) {
  return createAgentSession({ agentId: 'codex', createdAt, id, taskId: 'task-1' });
}
