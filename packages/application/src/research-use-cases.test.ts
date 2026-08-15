import { describe, expect, it, vi } from 'vitest';

import {
  ExecutionArtifactKind,
  TaskPhase,
  createExecutionArtifact,
  type AgentSession,
  type ExecutionArtifact,
} from '@agentterm/domain';

import {
  ArtifactProvenanceError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  TaskResearchPhaseError,
} from './errors';
import {
  hasValidResearchEvidence,
  recordResearchArtifact,
  type RecordResearchArtifactDependencies,
} from './research-use-cases';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
} from './ports';

class InMemorySessionRepository implements AgentSessionRepository {
  public readonly sessions = new Map<string, AgentSession>();

  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.sessions.get(id);
  }

  public async insert(
    session: AgentSession,
    expectedTaskPhase?: 'BACKLOG' | 'PLANNING' | 'RUNNING',
  ): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new EntityAlreadyExistsError('AgentSession', session.id);
    }
    void expectedTaskPhase;
    this.sessions.set(session.id, session);
  }

  public async append(): Promise<void> {}

  public async updateOwnership(): Promise<void> {}

  public async listActive(): Promise<readonly AgentSession[]> {
    return Object.freeze([...this.sessions.values()].filter((s) => s.status === 'RUNNING'));
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return Object.freeze(
      [...this.sessions.values()].filter((s) => s.taskId === taskId),
    );
  }
}

class InMemoryArtifactRepository implements ExecutionArtifactRepository {
  public readonly artifacts = new Map<string, ExecutionArtifact>();

  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    return this.artifacts.get(id);
  }

  public async findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined> {
    const matches = [...this.artifacts.values()].filter(
      (artifact) => artifact.taskId === taskId && artifact.kind === kind,
    );
    return matches[matches.length - 1];
  }

  public async insert(artifact: ExecutionArtifact): Promise<void> {
    if (this.artifacts.has(artifact.id)) {
      throw new EntityAlreadyExistsError('ExecutionArtifact', artifact.id);
    }
    this.artifacts.set(artifact.id, artifact);
  }

  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    return Object.freeze(
      [...this.artifacts.values()].filter((artifact) => artifact.taskId === taskId),
    );
  }

  public async listRecentByTaskId(): Promise<readonly ExecutionArtifact[]> {
    return Object.freeze([]);
  }

  public async readReviewEvidenceByTaskId(): Promise<{
    readonly evidence: readonly never[];
    readonly totalCount: number;
  }> {
    return Object.freeze({ evidence: [], totalCount: 0 });
  }
}

function makeTaskRepo(tasks: ReadonlyMap<string, { id: string; phase: TaskPhase }>) {
  return {
    async findById(id: string) {
      const task = tasks.get(id);
      return task === undefined
        ? undefined
        : ({
            blockedReason: undefined,
            brief: 'Investigate',
            createdAt: 0,
            description: '',
            id: task.id,
            phase: task.phase,
            projectId: 'project-1',
            title: 'Investigate',
            updatedAt: 0,
            worktreeId: undefined,
          } as unknown);
    },
  };
}

describe('recordResearchArtifact', () => {
  function setupDeps(taskPhase: TaskPhase): {
    deps: RecordResearchArtifactDependencies;
    sessions: InMemorySessionRepository;
    artifacts: InMemoryArtifactRepository;
  } {
    const sessions = new InMemorySessionRepository();
    const artifacts = new InMemoryArtifactRepository();
    const tasks = makeTaskRepo(new Map([['task-1', { id: 'task-1', phase: taskPhase }]]));
    return { deps: { artifacts, sessions, tasks: tasks as never }, sessions, artifacts };
  }

  it('persists a research artifact whose canonical name and phase match BACKLOG', async () => {
    const { deps, artifacts } = setupDeps(TaskPhase.BACKLOG);
    await deps.sessions.insert({
      agentId: 'agent-1',
      createdAt: 0,
      history: Object.freeze([]),
      id: 'session-1',
      status: 'IDLE',
      taskId: 'task-1',
    } as AgentSession);

    const stored = await recordResearchArtifact(
      {
        content: '# Research\n\nFindings body.',
        createdAt: 1_700_000_000_000,
        id: 'research-1',
        sessionId: 'session-1',
        taskId: 'task-1',
      },
      deps,
    );

    expect(stored.kind).toBe(ExecutionArtifactKind.RESEARCH);
    expect(stored.canonicalName).toBe('research/research.md');
    expect(stored.phase).toBe(TaskPhase.BACKLOG);
    expect(stored.taskId).toBe('task-1');
    expect(artifacts.artifacts.get('research-1')).toBeDefined();
  });

  it('rejects records for a Task that is not in BACKLOG', async () => {
    const { deps } = setupDeps(TaskPhase.PLANNING);
    await deps.sessions.insert({
      agentId: 'agent-1',
      createdAt: 0,
      history: Object.freeze([]),
      id: 'session-1',
      status: 'IDLE',
      taskId: 'task-1',
    } as AgentSession);
    await expect(
      recordResearchArtifact(
        {
          content: '# Research\n\nBody.',
          createdAt: 1,
          id: 'r1',
          sessionId: 'session-1',
          taskId: 'task-1',
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(TaskResearchPhaseError);
  });

  it('rejects records when the Agent Session does not belong to the Task', async () => {
    const { deps } = setupDeps(TaskPhase.BACKLOG);
    await deps.sessions.insert({
      agentId: 'agent-1',
      createdAt: 0,
      history: Object.freeze([]),
      id: 'session-1',
      status: 'IDLE',
      taskId: 'task-2',
    } as AgentSession);
    await expect(
      recordResearchArtifact(
        {
          content: '# Research\n\nBody.',
          createdAt: 1,
          id: 'r1',
          sessionId: 'session-1',
          taskId: 'task-1',
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(ArtifactProvenanceError);
  });

  it('rejects records when the Task does not exist', async () => {
    const sessions = new InMemorySessionRepository();
    const artifacts = new InMemoryArtifactRepository();
    const tasks = makeTaskRepo(new Map());
    await expect(
      recordResearchArtifact(
        {
          content: '# Research\n\nBody.',
          createdAt: 1,
          id: 'r1',
          sessionId: 'session-1',
          taskId: 'task-missing',
        },
        { artifacts, sessions, tasks: tasks as never },
      ),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('rejects content without the # Research heading', async () => {
    const { deps } = setupDeps(TaskPhase.BACKLOG);
    await deps.sessions.insert({
      agentId: 'agent-1',
      createdAt: 0,
      history: Object.freeze([]),
      id: 'session-1',
      status: 'IDLE',
      taskId: 'task-1',
    } as AgentSession);
    await expect(
      recordResearchArtifact(
        {
          content: '# Something else\n\nbody',
          createdAt: 1,
          id: 'r1',
          sessionId: 'session-1',
          taskId: 'task-1',
        },
        deps,
      ),
    ).rejects.toThrow(/Research/);
  });
});

describe('startTaskResearch preflight', () => {
  it('refuses to start research when the Task is not in BACKLOG', async () => {
    const { startTaskResearch } = await import('./research-use-cases');
    const tasks = makeTaskRepo(new Map([['task-1', { id: 'task-1', phase: TaskPhase.RUNNING }]]));
    const sessions = new InMemorySessionRepository();
    const deps = {
      git: { ensure: vi.fn() },
      localProjects: { locate: vi.fn() },
      sessionCoordinator: {
        isAgentConfigured: () => true,
        listByTaskId: vi.fn().mockResolvedValue([]),
        findOwnedRuntimeByTaskId: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
      },
      tasks: tasks as never,
      worktrees: {},
    };
    await expect(
      startTaskResearch(
        {
          agentId: 'agent-1',
          environment: Object.freeze({}),
          initialSize: { cols: 80, rows: 24 },
          sessionId: 'session-r1',
          taskId: 'task-1',
        },
        deps as never,
      ),
    ).rejects.toBeInstanceOf(TaskResearchPhaseError);
    void sessions;
  });

  it('refuses to start research when the session id already exists', async () => {
    const { startTaskResearch } = await import('./research-use-cases');
    const tasks = makeTaskRepo(new Map([['task-1', { id: 'task-1', phase: TaskPhase.BACKLOG }]]));
    const deps = {
      git: { ensure: vi.fn() },
      localProjects: { locate: vi.fn() },
      sessionCoordinator: {
        isAgentConfigured: () => true,
        listByTaskId: vi.fn().mockResolvedValue([]),
        findOwnedRuntimeByTaskId: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue({
          agentId: 'agent-1',
          createdAt: 0,
          history: Object.freeze([]),
          id: 'session-r1',
          status: 'IDLE',
          taskId: 'task-1',
        } as AgentSession),
        start: vi.fn(),
      },
      tasks: tasks as never,
      worktrees: {},
    };
    await expect(
      startTaskResearch(
        {
          agentId: 'agent-1',
          environment: Object.freeze({}),
          initialSize: { cols: 80, rows: 24 },
          sessionId: 'session-r1',
          taskId: 'task-1',
        },
        deps as never,
      ),
    ).rejects.toBeInstanceOf(EntityAlreadyExistsError);
  });

  it('refuses to start research when an unsettled session already exists', async () => {
    const { startTaskResearch } = await import('./research-use-cases');
    const tasks = makeTaskRepo(new Map([['task-1', { id: 'task-1', phase: TaskPhase.BACKLOG }]]));
    const deps = {
      git: { ensure: vi.fn() },
      localProjects: { locate: vi.fn() },
      sessionCoordinator: {
        isAgentConfigured: () => true,
        listByTaskId: vi.fn().mockResolvedValue([
          {
            agentId: 'agent-1',
            createdAt: 0,
            history: Object.freeze([
              {
                kind: 'INPUT_DELIVERED',
                at: 0,
                bytes: 0,
                sequence: 0,
                writer: { kind: 'PTY', sessionId: 'session-active', sink: 'PTY' },
              },
            ]),
            id: 'session-active',
            status: 'RUNNING',
            taskId: 'task-1',
          } as AgentSession,
        ]),
        findOwnedRuntimeByTaskId: vi.fn().mockResolvedValue(undefined),
        findById: vi.fn().mockResolvedValue(undefined),
        start: vi.fn(),
      },
      tasks: tasks as never,
      worktrees: {},
    };
    await expect(
      startTaskResearch(
        {
          agentId: 'agent-1',
          environment: Object.freeze({}),
          initialSize: { cols: 80, rows: 24 },
          sessionId: 'session-r1',
          taskId: 'task-1',
        },
        deps as never,
      ),
    ).rejects.toThrow();
  });
});

describe('hasValidResearchEvidence', () => {
  it('returns true when a VALID research artifact exists for the Task', async () => {
    const artifacts = new InMemoryArtifactRepository();
    artifacts.artifacts.set(
      'research-1',
      createExecutionArtifact({
        content: '# Research\n\nBody.',
        createdAt: 1,
        id: 'research-1',
        kind: ExecutionArtifactKind.RESEARCH,
        taskId: 'task-1',
      }),
    );
    expect(await hasValidResearchEvidence({ artifacts, taskId: 'task-1' })).toBe(true);
  });

  it('returns false when no research artifact exists', async () => {
    const artifacts = new InMemoryArtifactRepository();
    expect(await hasValidResearchEvidence({ artifacts, taskId: 'task-1' })).toBe(false);
  });

  it('returns false when the most recent research artifact is invalid', async () => {
    const artifacts = new InMemoryArtifactRepository();
    const good = createExecutionArtifact({
      content: '# Research\n\nBody.',
      createdAt: 1,
      id: 'research-1',
      kind: ExecutionArtifactKind.RESEARCH,
      taskId: 'task-1',
    });
    artifacts.artifacts.set('research-1', { ...good, validation: 'INVALID' as 'VALID' });
    expect(await hasValidResearchEvidence({ artifacts, taskId: 'task-1' })).toBe(false);
  });
});