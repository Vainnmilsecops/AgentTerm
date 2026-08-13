import { describe, expect, it } from 'vitest';

import { createAgentSession, recordAgentSessionEvent, type AgentSession } from '@agentterm/domain';

import {
  AgentSessionPersistenceError,
  restoreAgentWorkspaceAfterRestart,
  restoreAgentSessionsAfterRestart,
  type AgentCatalog,
  type AgentSessionRepository,
} from './index';
import { createProject, createTask, TaskPhase, transitionTask } from '@agentterm/domain';

const createdAt = 1_800_000_000_000;
const agents: AgentCatalog = {
  findById: (id) => (id === 'codex' ? agents.list()[0] : undefined),
  list: () => [
    {
      identity: { displayName: 'Codex', id: 'codex' },
      inspect: async () => ({
        capabilities: ['SESSION_RESUME'],
        executablePath: 'D:\\private\\codex.exe',
        kind: 'available',
      }),
      buildLaunchCommand: async () => {
        throw new Error('not used during restore');
      },
    },
  ],
};

class MemoryAgentSessionRepository implements AgentSessionRepository {
  private readonly stored = new Map<string, AgentSession>();
  public failAppendFor: string | undefined;

  public constructor(sessions: readonly AgentSession[]) {
    for (const session of sessions) {
      this.stored.set(session.id, session);
    }
  }

  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.stored.get(id);
  }

  public async insert(session: AgentSession): Promise<void> {
    this.stored.set(session.id, session);
  }

  public async append(session: AgentSession, expectedSequence: number): Promise<void> {
    if (this.failAppendFor === session.id) {
      throw new Error('injected persistence failure');
    }
    const current = this.stored.get(session.id);
    if (current === undefined || current.history.length !== expectedSequence) {
      throw new Error('stale session revision');
    }
    this.stored.set(session.id, session);
  }

  public async listActive(): Promise<readonly AgentSession[]> {
    return [...this.stored.values()].filter(hasUnsettledRuntimeOwnership);
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return [...this.stored.values()].filter((session) => session.taskId === taskId);
  }
}

describe('restoreAgentSessionsAfterRestart', () => {
  it('marks every persisted active status FAILED without replacing terminal history', async () => {
    const starting = startingSession('session-starting');
    const working = reportStatus(startingSession('session-working'), 'WORKING', 1);
    const idle = reportStatus(reportStatus(startingSession('session-idle'), 'WORKING', 1), 'IDLE');
    const waiting = reportStatus(
      reportStatus(startingSession('session-waiting'), 'WORKING', 1),
      'WAITING_INPUT',
    );
    const exited = recordAgentSessionEvent(startingSession('session-exited'), {
      exitCode: 0,
      kind: 'PROCESS_EXITED',
      occurredAt: createdAt + 10,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 1,
    });
    const failed = recordAgentSessionEvent(startingSession('session-failed'), {
      code: 'START_FAILED',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: createdAt + 11,
      stage: 'START',
    });
    const activeSessions = [starting, working, idle, waiting];
    const repository = new MemoryAgentSessionRepository([...activeSessions, exited, failed]);

    const result = await restoreAgentSessionsAfterRestart(repository, () => createdAt + 100);

    expect(result.reconciledSessions).toHaveLength(4);
    for (const previous of activeSessions) {
      const restored = await repository.findById(previous.id);
      expect(restored).toMatchObject({
        endedAt: createdAt + 100,
        id: previous.id,
        status: 'FAILED',
      });
      expect(restored?.history.slice(0, -1)).toEqual(previous.history);
      expect(restored?.history.at(-1)).toEqual({
        code: 'RUNTIME_OWNERSHIP_LOST',
        fatal: true,
        kind: 'RUNTIME_FAILED',
        occurredAt: createdAt + 100,
        sequence: previous.history.length + 1,
        stage: 'RUNTIME',
        status: 'FAILED',
      });
    }
    await expect(repository.findById(exited.id)).resolves.toEqual(exited);
    await expect(repository.findById(failed.id)).resolves.toEqual(failed);
  });

  it('is idempotent when startup reconciliation runs again', async () => {
    const repository = new MemoryAgentSessionRepository([startingSession('session-1')]);

    const first = await restoreAgentSessionsAfterRestart(repository, () => createdAt + 1);
    const restored = await repository.findById('session-1');
    const second = await restoreAgentSessionsAfterRestart(repository, () => createdAt + 2);

    expect(first.reconciledSessions).toEqual([restored]);
    expect(second.reconciledSessions).toEqual([]);
    await expect(repository.findById('session-1')).resolves.toEqual(restored);
  });

  it('reconciles a fatal runtime failure whose process exit was never observed', async () => {
    const failedWithoutExit = recordAgentSessionEvent(startingSession('session-1'), {
      code: 'RUNTIME_FAILURE',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: createdAt + 1,
      runtimeSequence: 1,
      stage: 'RUNTIME',
    });
    const repository = new MemoryAgentSessionRepository([failedWithoutExit]);

    const result = await restoreAgentSessionsAfterRestart(repository, () => createdAt + 2);

    expect(result.reconciledSessions).toHaveLength(1);
    await expect(repository.findById('session-1')).resolves.toMatchObject({
      history: [
        { kind: 'START_REQUESTED' },
        { code: 'RUNTIME_FAILURE', kind: 'RUNTIME_FAILED', stage: 'RUNTIME' },
        {
          code: 'RUNTIME_OWNERSHIP_LOST',
          kind: 'RUNTIME_FAILED',
          stage: 'RUNTIME',
        },
      ],
      status: 'FAILED',
    });
  });

  it('preserves earlier reconciliations and reports the still-active session on partial failure', async () => {
    const repository = new MemoryAgentSessionRepository([
      startingSession('session-1'),
      startingSession('session-2'),
    ]);
    repository.failAppendFor = 'session-2';

    await expect(restoreAgentSessionsAfterRestart(repository, () => createdAt + 1)).rejects.toEqual(
      new AgentSessionPersistenceError('session-2'),
    );
    await expect(repository.findById('session-1')).resolves.toMatchObject({ status: 'FAILED' });
    await expect(repository.findById('session-2')).resolves.toMatchObject({ status: 'STARTING' });

    repository.failAppendFor = undefined;
    await expect(
      restoreAgentSessionsAfterRestart(repository, () => createdAt + 2),
    ).resolves.toMatchObject({
      reconciledSessions: [{ id: 'session-2', status: 'FAILED' }],
    });
  });

  it('does not write an event timestamp before existing durable history', async () => {
    const working = reportStatus(startingSession('session-1'), 'WORKING', 1);
    const repository = new MemoryAgentSessionRepository([working]);

    await restoreAgentSessionsAfterRestart(repository, () => createdAt - 1);

    await expect(repository.findById('session-1')).resolves.toMatchObject({
      history: [
        { occurredAt: createdAt },
        { occurredAt: createdAt + 1 },
        { code: 'RUNTIME_OWNERSHIP_LOST', occurredAt: createdAt + 1 },
      ],
    });
  });
});

describe('restoreAgentWorkspaceAfterRestart', () => {
  it('reconciles lost runtime ownership before returning the workspace read model', async () => {
    const repository = new MemoryAgentSessionRepository([
      reportStatus(startingSession('session-1'), 'WORKING', 1),
    ]);
    const project = createProject({ id: 'project-1', name: 'AgentTerm' });
    const task = transitionTask(
      transitionTask(
        createTask({ id: 'task-1', projectId: project.id, title: 'Restore' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );

    const overview = await restoreAgentWorkspaceAfterRestart(
      {
        listRecent: async () => [{ ...project, rootPath: 'D:\\repo' }],
        recordOpen: async () => never(),
      },
      { listByProjectId: async () => [task] },
      repository,
      {
        findById: async () => undefined,
        findLatestByTaskIdAndKind: async () => undefined,
        insert: async () => undefined,
        listByTaskId: async () => [],
        listRecentByTaskId: async () => [],
        readReviewEvidenceByTaskId: async () => ({ evidence: [], totalCount: 0 }),
      },
      {
        finalize: async () => never(),
        findById: async () => undefined,
        insert: async () => never(),
        listByTaskId: async () => [],
        listRecentByTaskId: async () => [],
        readReviewEvidenceByTaskId: async () => ({
          evidence: [],
          hasRunning: false,
          totalCount: 0,
        }),
      },
      {
        begin: async () => never(),
        decide: async () => never(),
        findById: async () => undefined,
        listByTaskId: async () => [],
        listRecentByTaskId: async () => [],
      },
      agents,
      {
        add: async () => never(),
        listByProjectId: async () => [],
        listByTaskId: async () => [],
        remove: async () => false,
      },
      () => createdAt + 100,
    );

    expect(overview.agents).toEqual([
      { capabilities: ['SESSION_RESUME'], displayName: 'Codex', id: 'codex', kind: 'available' },
    ]);
    expect(overview.projects[0]?.tasks[0]).toMatchObject({
      activeSession: undefined,
      canRetryExecution: true,
      latestSession: {
        failureCode: 'RUNTIME_OWNERSHIP_LOST',
        id: 'session-1',
        status: 'FAILED',
      },
      task: { phase: 'RUNNING' },
    });
  });
});

function startingSession(id: string): AgentSession {
  return createAgentSession({ agentId: 'codex', createdAt, id, taskId: 'task-1' });
}

function reportStatus(
  session: AgentSession,
  status: 'IDLE' | 'WAITING_INPUT' | 'WORKING',
  runtimeSequence?: number,
): AgentSession {
  return recordAgentSessionEvent(session, {
    kind: 'STATUS_REPORTED',
    occurredAt: session.history.at(-1)!.occurredAt + 1,
    ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
    source: runtimeSequence === undefined ? 'APPLICATION' : 'RUNTIME',
    status,
  });
}

function never(): never {
  throw new Error('recordOpen is not used during workspace restore');
}

function hasUnsettledRuntimeOwnership(session: AgentSession): boolean {
  if (session.status === 'EXITED') {
    return false;
  }
  if (session.status !== 'FAILED') {
    return true;
  }
  if (session.history.some((event) => event.kind === 'PROCESS_EXITED')) {
    return false;
  }
  return !session.history.some(
    (event) =>
      event.kind === 'RUNTIME_FAILED' &&
      event.fatal &&
      (event.stage === 'START' || event.code === 'RUNTIME_OWNERSHIP_LOST'),
  );
}
