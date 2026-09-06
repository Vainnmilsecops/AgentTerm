import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ExecutionArtifactKind,
  TaskPhase,
  createAgentSession,
  createProject,
  createTask,
  type Task,
} from '@agentterm/domain';
import {
  recordResearchArtifact,
  type RecordResearchArtifactDependencies,
} from '@agentterm/application';
import { describe, expect, it } from 'vitest';

import { openSqlitePersistence, type SqlitePersistence } from './index';

interface Harness {
  readonly dependencies: RecordResearchArtifactDependencies;
  readonly persistence: SqlitePersistence;
}

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-research-orchestrator-e2e-'));
  const databasePath = join(directory, 'agentterm.db');
  const persistence = openSqlitePersistence(databasePath);
  try {
    await persistence.projects.insert(
      createProject({ id: 'project-e2e', name: 'E2E' }),
    );
    const dependencies: RecordResearchArtifactDependencies = {
      applicationSettings: persistence.settings,
      artifacts: persistence.artifacts,
      sessions: persistence.sessions,
      taskTransitions: persistence.taskTransitions,
      tasks: persistence.tasks,
    };
    await run({ dependencies, persistence });
  } finally {
    persistence.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

async function flushMicrotasks(): Promise<void> {
  // The orchestrator is fire-and-forget; await several microtask flushes
  // so the awaited assertion can observe the persisted audit row.
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

async function seedBacklogTask(persistence: SqlitePersistence, taskId: string): Promise<Task> {
  const task = createTask({ id: taskId, projectId: 'project-e2e', title: taskId });
  await persistence.tasks.insert(task);
  return task;
}

async function seedIdleSession(
  persistence: SqlitePersistence,
  taskId: string,
  sessionId: string,
): Promise<void> {
  await persistence.sessions.insert(
    createAgentSession({ agentId: 'agent-e2e', createdAt: 0, id: sessionId, taskId }),
    TaskPhase.BACKLOG,
  );
}

describe('M6 RESEARCH_AUTO_ADVANCE end-to-end (SQLite)', () => {
  it('writes a RESEARCH_AUTO_ADVANCE audit row when researchAutoAdvance is enabled', async () => {
    await withHarness(async ({ dependencies, persistence }) => {
      // 1. Seed a BACKLOG task with an AgentSession.
      await seedBacklogTask(persistence, 'task-e2e-1');
      await seedIdleSession(persistence, 'task-e2e-1', 'session-e2e-1');

      // 2. Opt in to auto-advance.
      const initialSettings = await persistence.settings.get();
      await persistence.settings.update(
        {
          ...initialSettings,
          researchAutoAdvance: true,
          revision: initialSettings.revision + 1,
        },
        initialSettings.revision,
      );

      // 3. Record a VALID research artifact through the use case.
      const artifact = await recordResearchArtifact(
        {
          content: '# Research\n\nFindings body.',
          createdAt: 1_700_000_000_000,
          id: 'artifact-e2e-1',
          sessionId: 'session-e2e-1',
          taskId: 'task-e2e-1',
        },
        dependencies,
      );
      expect(artifact.kind).toBe(ExecutionArtifactKind.RESEARCH);
      expect(artifact.validation).toBe('VALID');

      // 4. Fire-and-forget orchestrator must complete and persist the audit row.
      await flushMicrotasks();

      const transitions = await persistence.taskTransitions.listByTaskId('task-e2e-1');
      expect(transitions).toHaveLength(1);
      const row = transitions[0];
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        artifactId: 'artifact-e2e-1',
        fromPhase: TaskPhase.BACKLOG,
        taskId: 'task-e2e-1',
        toPhase: TaskPhase.PLANNING,
        trigger: 'research-auto-advance',
      });

      const movedTask = await persistence.tasks.findById('task-e2e-1');
      expect(movedTask?.phase).toBe(TaskPhase.PLANNING);
    });
  });

  it('skips the audit row when researchAutoAdvance is disabled', async () => {
    await withHarness(async ({ dependencies, persistence }) => {
      await seedBacklogTask(persistence, 'task-e2e-2');
      await seedIdleSession(persistence, 'task-e2e-2', 'session-e2e-2');
      // researchAutoAdvance defaults to false; do not enable it.

      await recordResearchArtifact(
        {
          content: '# Research\n\nBody.',
          createdAt: 1_700_000_001_000,
          id: 'artifact-e2e-2',
          sessionId: 'session-e2e-2',
          taskId: 'task-e2e-2',
        },
        dependencies,
      );

      await flushMicrotasks();

      const transitions = await persistence.taskTransitions.listByTaskId('task-e2e-2');
      expect(transitions).toEqual([]);

      const task = await persistence.tasks.findById('task-e2e-2');
      expect(task?.phase).toBe(TaskPhase.BACKLOG);
    });
  });

  it('persists the research artifact independently of the orchestrator decision', async () => {
    await withHarness(async ({ dependencies, persistence }) => {
      await seedBacklogTask(persistence, 'task-e2e-3');
      await seedIdleSession(persistence, 'task-e2e-3', 'session-e2e-3');

      const artifact = await recordResearchArtifact(
        {
          content: '# Research\n\nBody.',
          createdAt: 1_700_000_002_000,
          id: 'artifact-e2e-3',
          sessionId: 'session-e2e-3',
          taskId: 'task-e2e-3',
        },
        dependencies,
      );

      const stored = await persistence.artifacts.findById(artifact.id);
      expect(stored).toBeDefined();
      expect(stored?.kind).toBe(ExecutionArtifactKind.RESEARCH);
    });
  });
});
