import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  createExecutionArtifact as createExecutionArtifactUseCase,
  EntityAlreadyExistsError,
  getExecutionArtifact,
  listTaskExecutionArtifacts,
} from '@agentterm/application';
import {
  createAgentSession,
  createExecutionArtifact,
  createProject,
  createTask,
  ExecutionArtifactKind,
  TaskPhase,
  transitionTask,
} from '@agentterm/domain';

import { openSqlitePersistence, SqlitePersistenceError } from './index';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-artifact-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function seedTaskAndSession(databasePath: string): Promise<void> {
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
    const backlog = createTask({
      id: 'task-1',
      projectId: 'project-1',
      title: 'Execution artifacts',
    });
    await persistence.tasks.insert(
      transitionTask(transitionTask(backlog, TaskPhase.PLANNING), TaskPhase.RUNNING),
    );
    await persistence.sessions.insert(
      createAgentSession({ agentId: 'codex', createdAt: 10, id: 'session-1', taskId: 'task-1' }),
    );
  } finally {
    persistence.close();
  }
}

describe('SQLite Execution Artifact persistence', () => {
  it('round-trips Task and Session provenance across connections', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath);
      const artifact = createExecutionArtifact({
        content: '# Execution Summary\n\nĐã hoàn tất nền tảng artifact.',
        createdAt: 20,
        id: 'artifact-1',
        kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
        sessionId: 'session-1',
        taskId: 'task-1',
      });
      const persistence = openSqlitePersistence(databasePath);
      try {
        await expect(
          createExecutionArtifactUseCase(
            {
              content: artifact.content,
              createdAt: artifact.createdAt,
              id: artifact.id,
              kind: artifact.kind,
              ...(artifact.sessionId === undefined ? {} : { sessionId: artifact.sessionId }),
              taskId: artifact.taskId,
            },
            persistence.tasks,
            persistence.sessions,
            persistence.artifacts,
          ),
        ).resolves.toEqual(artifact);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.artifacts.findById('artifact-1')).resolves.toEqual(artifact);
        await expect(getExecutionArtifact('artifact-1', reopened.artifacts)).resolves.toEqual(
          artifact,
        );
        await expect(
          listTaskExecutionArtifacts('task-1', reopened.tasks, reopened.artifacts),
        ).resolves.toEqual([artifact]);
        await expect(reopened.tasks.findById('task-1')).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
      } finally {
        reopened.close();
      }
    });
  });

  it('preserves repeated canonical outputs as ordered immutable history', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      const first = createExecutionArtifact({
        content: '# Plan\n\nPhiên bản đầu tiên.',
        createdAt: 20,
        id: 'artifact-plan-1',
        kind: ExecutionArtifactKind.PLAN,
        taskId: 'task-1',
      });
      const second = createExecutionArtifact({
        content: '# Plan\n\nPhiên bản từ session mới.',
        createdAt: 20,
        id: 'artifact-plan-2',
        kind: ExecutionArtifactKind.PLAN,
        sessionId: 'session-1',
        taskId: 'task-1',
      });
      try {
        await persistence.artifacts.insert(first);
        await persistence.artifacts.insert(second);
        await expect(
          persistence.artifacts.insert({ ...first, content: '# Plan\n\nOverwrite.' }),
        ).rejects.toBeInstanceOf(EntityAlreadyExistsError);
        await expect(persistence.artifacts.listByTaskId('task-1')).resolves.toEqual([
          first,
          second,
        ]);
        await expect(persistence.artifacts.listRecentByTaskId('task-1', 1)).resolves.toEqual([
          second,
        ]);
        await expect(
          persistence.artifacts.readReviewEvidenceByTaskId('task-1', 1),
        ).resolves.toEqual({ evidence: [], totalCount: 2 });
        const boundedEvidence = await persistence.artifacts.readReviewEvidenceByTaskId('task-1', 2);
        expect(boundedEvidence).toEqual({
          evidence: [
            {
              createdAt: first.createdAt,
              id: first.id,
              kind: first.kind,
              phase: first.phase,
              sessionId: first.sessionId,
            },
            {
              createdAt: second.createdAt,
              id: second.id,
              kind: second.kind,
              phase: second.phase,
              sessionId: second.sessionId,
            },
          ],
          totalCount: 2,
        });
        expect(boundedEvidence.evidence[0]).not.toHaveProperty('content');
      } finally {
        persistence.close();
      }
    });
  });

  it('enforces Task and same-Task Session provenance at the database boundary', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.projects.insert(createProject({ id: 'project-2', name: 'Other' }));
        await persistence.tasks.insert(
          createTask({ id: 'task-2', projectId: 'project-2', title: 'Other Task' }),
        );
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
      try {
        const insert = database.prepare(
          `INSERT INTO execution_artifacts (
             id, task_id, session_id, ordinal, kind, phase, canonical_name,
             format, schema_version, validation, content, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        expect(() =>
          insert.run(
            'missing-task',
            'missing',
            null,
            1,
            'plan',
            'PLANNING',
            'planning/plan.md',
            'markdown',
            1,
            'VALID',
            '# Plan\n\nNo Task.',
            20,
          ),
        ).toThrow();
        expect(() =>
          insert.run(
            'wrong-session-task',
            'task-2',
            'session-1',
            1,
            'review',
            'REVIEW',
            'review/review.md',
            'markdown',
            1,
            'VALID',
            '# Review\n\nWrong provenance.',
            20,
          ),
        ).toThrow();
        expect(database.prepare('SELECT count(*) AS count FROM execution_artifacts').get()).toEqual(
          { count: 0 },
        );
      } finally {
        database.close();
      }
    });
  });

  it('rejects corrupted stored contract metadata during Domain mapping', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.artifacts.insert(
          createExecutionArtifact({
            content: '# Review\n\nSafe review.',
            createdAt: 20,
            id: 'artifact-review',
            kind: ExecutionArtifactKind.REVIEW,
            taskId: 'task-1',
          }),
        );
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath);
      try {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database
          .prepare('UPDATE execution_artifacts SET canonical_name = ? WHERE id = ?')
          .run('outside/secret.txt', 'artifact-review');
      } finally {
        database.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.artifacts.findById('artifact-review')).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
      } finally {
        reopened.close();
      }
    });
  });

  it('rejects a stale artifact schema version during Domain mapping', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath);
      const persistence = openSqlitePersistence(databasePath);
      try {
        await persistence.artifacts.insert(
          createExecutionArtifact({
            content: '# Plan\n\nVersioned contract.',
            createdAt: 20,
            id: 'artifact-plan',
            kind: ExecutionArtifactKind.PLAN,
            taskId: 'task-1',
          }),
        );
      } finally {
        persistence.close();
      }

      const database = new DatabaseSync(databasePath);
      try {
        database.exec('PRAGMA ignore_check_constraints = ON');
        database
          .prepare('UPDATE execution_artifacts SET schema_version = ? WHERE id = ?')
          .run(2, 'artifact-plan');
      } finally {
        database.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        await expect(reopened.artifacts.findById('artifact-plan')).rejects.toBeInstanceOf(
          SqlitePersistenceError,
        );
      } finally {
        reopened.close();
      }
    });
  });
});
