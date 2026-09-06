import { describe, expect, it } from 'vitest';

import {
  ExecutionArtifactKind,
  TaskPhase,
  type AgentSession,
  type ExecutionArtifact,
  type Task,
} from '@agentterm/domain';

import {
  ArtifactProvenanceError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
} from './errors';
import {
  recordBrainstormArtifact,
  recordSweepArtifact,
  type RecordSessionNoteDependencies,
  type RecordSessionNoteInput,
} from './note-capture-use-cases';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  TaskRepository,
} from './ports';

class InMemorySessionRepository implements AgentSessionRepository {
  public readonly sessions = new Map<string, AgentSession>();

  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.sessions.get(id);
  }

  public async insert(
    session: AgentSession,
    _expectedTaskPhase?: 'BACKLOG' | 'PLANNING' | 'RUNNING',
  ): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new EntityAlreadyExistsError('AgentSession', session.id);
    }
    this.sessions.set(session.id, session);
  }

  public async append(): Promise<void> {}

  public async updateOwnership(): Promise<void> {}

  public async listActive(): Promise<readonly AgentSession[]> {
    return Object.freeze([...this.sessions.values()]);
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
}

class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  public seed(task: Task): void {
    this.tasks.set(task.id, task);
  }

  public async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async insert(): Promise<void> {
    throw new Error('not used in these tests');
  }

  public async update(): Promise<void> {
    throw new Error('not used in these tests');
  }

  public async delete(): Promise<void> {
    throw new Error('not used in these tests');
  }

  public async listByProject(): Promise<readonly Task[]> {
    return Object.freeze([...this.tasks.values()]);
  }
}

function makeHarness(opts: {
  readonly sessionTaskId?: string;
  readonly taskPhase?: TaskPhase;
} = {}): {
  dependencies: RecordSessionNoteDependencies;
  artifacts: InMemoryArtifactRepository;
  sessions: InMemorySessionRepository;
  tasks: InMemoryTaskRepository;
} {
  const tasks = new InMemoryTaskRepository();
  tasks.seed({
    brief: 'Test brief',
    id: 'task-1',
    phase: opts.taskPhase ?? TaskPhase.PLANNING,
    projectId: 'project-1',
    title: 'Test task',
  });
  const sessions = new InMemorySessionRepository();
  sessions.insert({
    agentId: 'agent-1',
    createdAt: 0,
    id: 'session-1',
    status: 'IDLE',
    taskId: opts.sessionTaskId ?? 'task-1',
  } as unknown as AgentSession);
  const artifacts = new InMemoryArtifactRepository();
  return {
    artifacts,
    dependencies: {
      artifacts,
      sessions,
      tasks,
    },
    sessions,
    tasks,
  };
}

function makeInput(overrides: Partial<RecordSessionNoteInput> = {}): RecordSessionNoteInput {
  return {
    content: '# Brainstorm\n\nConsider row-level locking instead.',
    createdAt: 1_700_000_000_000,
    id: 'artifact-brainstorm-1',
    sessionId: 'session-1',
    taskId: 'task-1',
    ...overrides,
  };
}

describe('note-capture use cases (brainstorm / sweep)', () => {
  it('records a brainstorm artifact bound to the Task\'s current phase', async () => {
    const harness = makeHarness({ taskPhase: TaskPhase.PLANNING });
    const artifact = await recordBrainstormArtifact(makeInput(), harness.dependencies);
    expect(artifact.kind).toBe(ExecutionArtifactKind.BRAINSTORM);
    expect(artifact.phase).toBe(TaskPhase.PLANNING);
    expect(artifact.canonicalName).toBe('brainstorm/task-1-session-1-1700000000000.md');
    expect(harness.artifacts.artifacts.size).toBe(1);
  });

  it('records a sweep artifact bound to the Task\'s current phase', async () => {
    const harness = makeHarness({ taskPhase: TaskPhase.REVIEW });
    const artifact = await recordSweepArtifact(
      makeInput({
        content: '# Sweep\n\nFinal wrap-up notes.',
        id: 'artifact-sweep-1',
      }),
      harness.dependencies,
    );
    expect(artifact.kind).toBe(ExecutionArtifactKind.SWEEP);
    expect(artifact.phase).toBe(TaskPhase.REVIEW);
    expect(artifact.canonicalName).toBe('sweep/task-1-session-1-1700000000000.md');
  });

  it('refuses to record when the Agent Session does not exist', async () => {
    const harness = makeHarness();
    await expect(
      recordBrainstormArtifact(makeInput({ sessionId: 'missing' }), harness.dependencies),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('refuses to record when the Task does not exist', async () => {
    const harness = makeHarness();
    await expect(
      recordBrainstormArtifact(makeInput({ taskId: 'missing' }), harness.dependencies),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it('refuses to record when the session belongs to a different Task', async () => {
    const harness = makeHarness({ sessionTaskId: 'other-task' });
    await expect(
      recordBrainstormArtifact(makeInput(), harness.dependencies),
    ).rejects.toBeInstanceOf(ArtifactProvenanceError);
  });

  it('rejects a brainstorm note whose heading is wrong', async () => {
    const harness = makeHarness();
    await expect(
      recordBrainstormArtifact(
        makeInput({ content: '# Sweep\n\nBody.' }),
        harness.dependencies,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects a sweep note whose heading is wrong', async () => {
    const harness = makeHarness();
    await expect(
      recordSweepArtifact(
        makeInput({ content: '# Brainstorm\n\nBody.', id: 'artifact-sweep-x' }),
        harness.dependencies,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects a blank session id', async () => {
    const harness = makeHarness();
    await expect(
      recordBrainstormArtifact(makeInput({ sessionId: '   ' }), harness.dependencies),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects a negative timestamp', async () => {
    const harness = makeHarness();
    await expect(
      recordBrainstormArtifact(makeInput({ createdAt: -1 }), harness.dependencies),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('persists the artifact under a deterministic canonical name', async () => {
    const harness = makeHarness();
    await recordBrainstormArtifact(makeInput(), harness.dependencies);
    const stored = await harness.artifacts.findById('artifact-brainstorm-1');
    expect(stored).toBeDefined();
    expect(stored?.canonicalName.startsWith('brainstorm/task-1-session-1-')).toBe(true);
    expect(stored?.canonicalName.endsWith('.md')).toBe(true);
  });
});
