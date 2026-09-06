import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  recordBrainstormArtifact,
  recordSweepArtifact,
} from '@agentterm/application';
import {
  ExecutionArtifactKind,
  TaskPhase,
  createAgentSession,
  createExecutionArtifact,
  createProject,
  createTask,
  transitionTask,
} from '@agentterm/domain';

import { openSqlitePersistence } from './index';

async function withTemporaryDatabase(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-note-capture-'));
  const databasePath = join(directory, 'agentterm.db');
  try {
    await run(databasePath);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

async function seedTaskAndSession(databasePath: string, phase: TaskPhase): Promise<void> {
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(createProject({ id: 'project-1', name: 'AgentTerm' }));
    const initial = createTask({
      id: 'task-1',
      projectId: 'project-1',
      title: 'Brainstorm / Sweep persistence',
    });
    // A new Agent Session must be inserted while the Task is RUNNING.
    // Walk the Task to RUNNING first, insert the session, then move it on
    // to the requested capture-time phase so brainstorm/sweep artifacts are
    // bound to the phase the test expects.
    const planning = transitionTask(initial, TaskPhase.PLANNING);
    const running = transitionTask(planning, TaskPhase.RUNNING);
    await persistence.tasks.insert(running);
    await persistence.sessions.insert(
      createAgentSession({ agentId: 'codex', createdAt: 10, id: 'session-1', taskId: 'task-1' }),
      TaskPhase.RUNNING,
    );
    if (phase === TaskPhase.REVIEW) {
      await persistence.tasks.update(transitionTask(running, TaskPhase.REVIEW), TaskPhase.RUNNING);
    }
  } finally {
    persistence.close();
  }
}

describe('SQLite Execution Artifact persistence — brainstorm / sweep kinds', () => {
  it('round-trips a brainstorm artifact with a dynamic canonical name', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath, TaskPhase.RUNNING);
      const persistence = openSqlitePersistence(databasePath);
      try {
        // Walk the Task forward to REVIEW so the brainstorm is bound to a
        // phase that already has the same AgentSession attached.
        const running = await persistence.tasks.findById('task-1');
        expect(running?.phase).toBe(TaskPhase.RUNNING);
        const artifact = await recordBrainstormArtifact(
          {
            content: '# Brainstorm\n\nConsider row-level locking.',
            createdAt: 1_700_000_000_000,
            id: 'artifact-brainstorm-1',
            sessionId: 'session-1',
            taskId: 'task-1',
          },
          {
            artifacts: persistence.artifacts,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );
        expect(artifact.kind).toBe(ExecutionArtifactKind.BRAINSTORM);
        expect(artifact.canonicalName).toBe('brainstorm/task-1-session-1-1700000000000.md');
        expect(artifact.phase).toBe(TaskPhase.RUNNING);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        const stored = await reopened.artifacts.findById('artifact-brainstorm-1');
        expect(stored).toBeDefined();
        expect(stored?.kind).toBe(ExecutionArtifactKind.BRAINSTORM);
        expect(stored?.phase).toBe(TaskPhase.RUNNING);
        expect(stored?.canonicalName).toBe('brainstorm/task-1-session-1-1700000000000.md');
        const byKind = await reopened.artifacts.findLatestByTaskIdAndKind(
          'task-1',
          ExecutionArtifactKind.BRAINSTORM,
        );
        expect(byKind?.id).toBe('artifact-brainstorm-1');
      } finally {
        reopened.close();
      }
    });
  });

  it('round-trips a sweep artifact with a dynamic canonical name', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath, TaskPhase.REVIEW);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const artifact = await recordSweepArtifact(
          {
            content: '# Sweep\n\nFinal wrap-up before close.',
            createdAt: 1_700_000_000_500,
            id: 'artifact-sweep-1',
            sessionId: 'session-1',
            taskId: 'task-1',
          },
          {
            artifacts: persistence.artifacts,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );
        expect(artifact.kind).toBe(ExecutionArtifactKind.SWEEP);
        expect(artifact.canonicalName).toBe('sweep/task-1-session-1-1700000000500.md');
        expect(artifact.phase).toBe(TaskPhase.REVIEW);
      } finally {
        persistence.close();
      }

      const reopened = openSqlitePersistence(databasePath);
      try {
        const stored = await reopened.artifacts.findById('artifact-sweep-1');
        expect(stored?.kind).toBe(ExecutionArtifactKind.SWEEP);
        expect(stored?.phase).toBe(TaskPhase.REVIEW);
      } finally {
        reopened.close();
      }
    });
  });

  it('keeps brainstorm / sweep canonical names distinct across captures', async () => {
    await withTemporaryDatabase(async (databasePath) => {
      await seedTaskAndSession(databasePath, TaskPhase.PLANNING);
      const persistence = openSqlitePersistence(databasePath);
      try {
        const first = createExecutionArtifact({
          content: '# Brainstorm\n\nFirst note.',
          createdAt: 1_700_000_000_000,
          id: 'artifact-brainstorm-2',
          kind: ExecutionArtifactKind.BRAINSTORM,
          phase: TaskPhase.PLANNING,
          sessionId: 'session-1',
          taskId: 'task-1',
        });
        const second = createExecutionArtifact({
          content: '# Sweep\n\nFinal note.',
          createdAt: 1_700_000_000_500,
          id: 'artifact-sweep-2',
          kind: ExecutionArtifactKind.SWEEP,
          phase: TaskPhase.PLANNING,
          sessionId: 'session-1',
          taskId: 'task-1',
        });
        await persistence.artifacts.insert(first);
        await persistence.artifacts.insert(second);
        const history = await persistence.artifacts.listByTaskId('task-1');
        expect(history).toHaveLength(2);
        expect(history.map(({ canonicalName }) => canonicalName)).toEqual([
          'brainstorm/task-1-session-1-1700000000000.md',
          'sweep/task-1-session-1-1700000000500.md',
        ]);
      } finally {
        persistence.close();
      }
    });
  });
});
