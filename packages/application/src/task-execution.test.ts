import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionStatus,
  TaskPhase,
  createAgentSession,
  createTaskDependency,
  createTask,
  recordAgentSessionEvent,
  transitionTask,
  type AgentSession,
  type Task,
  type TaskDependency,
  type TaskPhase as TaskPhaseValue,
} from '@agentterm/domain';

import {
  AgentAdapterError,
  AgentNotConfiguredError,
  AgentSessionCoordinator,
  ConfiguredAgentCatalog,
  PtyRuntimeError,
  TaskExecutionRetryError,
  TaskExecutionStartError,
  retryTaskExecution,
  startTaskPlanning,
  startTaskExecution,
  type AgentAdapter,
  type AgentIdentity,
  type AgentLaunchRequest,
  type AgentSessionRepository,
  type GitTaskWorktreeLifecycle,
  type LocalProject,
  type LocalProjectLocator,
  type PtyHandle,
  type PtyLaunchSpec,
  type PtyRuntime,
  type PtyRuntimeEvent,
  type PtyRuntimeEventSink,
  type TaskRepository,
  type TaskDependencyRepository,
  type TaskWorktree,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from './index';

const project: LocalProject = Object.freeze({
  id: 'project-1',
  name: 'AgentTerm fixture',
  rootPath: 'C:\\repositories\\agentterm',
});
const primaryWorktree: TaskWorktree = Object.freeze({
  baseCommitId: '0123456789abcdef0123456789abcdef01234567',
  baseRefName: 'refs/heads/main',
  branchName: 'agentterm/task/0123456789abcdef',
  pathIdentity: 'windows:c:/worktrees/task-1',
  repositoryRootPath: project.rootPath,
  taskId: 'task-1',
  worktreePath: 'C:\\worktrees\\Task 1',
});
const cleanStatus = Object.freeze({
  conflictedPaths: [],
  ignoredPaths: [],
  isDirty: false,
  stagedPaths: [],
  unstagedPaths: [],
  untrackedPaths: [],
});
const executionInput = Object.freeze({
  agentId: 'codex',
  environment: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\AgentTerm' },
  initialSize: { columns: 120, rows: 36 },
  sessionId: 'session-1',
  taskId: primaryWorktree.taskId,
});
const retryInput = Object.freeze({
  agentId: executionInput.agentId,
  environment: executionInput.environment,
  initialSize: executionInput.initialSize,
  sessionId: executionInput.sessionId,
  taskId: executionInput.taskId,
});

class MemoryTaskRepository implements TaskRepository {
  private readonly stored = new Map<string, Task>();
  public failNextUpdate = false;
  public readonly update = vi.fn(async (task: Task, expectedPhase: Task['phase']) => {
    this.events.push(`task:${task.phase}`);
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('injected Task persistence failure');
    }
    if (this.stored.get(task.id)?.phase !== expectedPhase) {
      throw new Error('stale Task phase');
    }
    this.stored.set(task.id, task);
  });

  public constructor(
    tasks: readonly Task[],
    private readonly events: string[],
  ) {
    for (const task of tasks) {
      this.stored.set(task.id, task);
    }
  }

  public async findById(id: string): Promise<Task | undefined> {
    return this.stored.get(id);
  }

  public async insert(task: Task): Promise<void> {
    this.stored.set(task.id, task);
  }

  public replace(task: Task): void {
    this.stored.set(task.id, task);
  }
}

class MemoryTaskDependencyRepository implements TaskDependencyRepository {
  public dependencies: TaskDependency[] = [];

  public async add(dependency: TaskDependency): Promise<void> {
    this.dependencies.push(dependency);
  }

  public async remove(dependency: TaskDependency): Promise<boolean> {
    const before = this.dependencies.length;
    this.dependencies = this.dependencies.filter(
      (candidate) =>
        candidate.taskId !== dependency.taskId ||
        candidate.dependencyTaskId !== dependency.dependencyTaskId,
    );
    return before !== this.dependencies.length;
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskDependency[]> {
    return this.dependencies.filter((dependency) => dependency.taskId === taskId);
  }

  public async listByProjectId(): Promise<readonly TaskDependency[]> {
    return this.dependencies;
  }
}

class MemoryLocalProjectLocator implements LocalProjectLocator {
  public constructor(private readonly localProject: LocalProject) {}

  public async findLocalById(id: string): Promise<LocalProject | undefined> {
    return id === this.localProject.id ? this.localProject : undefined;
  }
}

class MemoryTaskWorktreeRepository implements TaskWorktreeRepository {
  public record: TaskWorktreeRecord | undefined;

  public constructor(private readonly events: string[]) {}

  public async findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined> {
    return this.record?.taskId === taskId ? this.record : undefined;
  }

  public async insertReservation(worktree: TaskWorktree): Promise<TaskWorktreeRecord> {
    if (this.record !== undefined) {
      throw new Error('duplicate primary Worktree');
    }
    this.events.push('worktree:PROVISIONING');
    this.record = Object.freeze({ ...worktree, lifecycleState: 'PROVISIONING' });
    return this.record;
  }

  public async transitionState(
    taskId: string,
    expectedState: TaskWorktreeRecord['lifecycleState'],
    nextState: TaskWorktreeRecord['lifecycleState'],
  ): Promise<TaskWorktreeRecord> {
    if (this.record?.taskId !== taskId || this.record.lifecycleState !== expectedState) {
      throw new Error('stale Worktree checkpoint');
    }
    this.events.push(`worktree:${expectedState}->${nextState}`);
    this.record = Object.freeze({ ...this.record, lifecycleState: nextState });
    return this.record;
  }
}

class MemoryGitWorktreeLifecycle implements GitTaskWorktreeLifecycle {
  public ensureFailure: Error | undefined;
  public ensureCalls = 0;
  public onEnsure: (() => void) | undefined;
  private present = false;

  public constructor(private readonly events: string[]) {}

  public async inspect(): Promise<Awaited<ReturnType<GitTaskWorktreeLifecycle['inspect']>>> {
    this.events.push('git:inspect');
    return this.present
      ? {
          headCommitId: primaryWorktree.baseCommitId,
          kind: 'present',
          status: cleanStatus,
          worktree: primaryWorktree,
        }
      : { kind: 'missing', worktree: primaryWorktree };
  }

  public async ensure(): Promise<Awaited<ReturnType<GitTaskWorktreeLifecycle['ensure']>>> {
    this.ensureCalls += 1;
    this.events.push('git:ensure');
    if (this.ensureFailure !== undefined) {
      throw this.ensureFailure;
    }
    this.present = true;
    this.onEnsure?.();
    return { kind: 'created', status: cleanStatus, worktree: primaryWorktree };
  }

  public async cleanup(): Promise<never> {
    throw new Error('cleanup is outside execution start');
  }
}

class MemoryAgentSessionRepository implements AgentSessionRepository {
  private readonly stored = new Map<string, AgentSession>();
  public failInsert = false;
  public failNextAppend = false;

  public constructor(private readonly events: string[]) {}

  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.stored.get(id);
  }

  public async insert(session: AgentSession): Promise<void> {
    this.events.push(`session:${session.status}`);
    if (this.failInsert) {
      throw new Error('injected Session persistence failure');
    }
    this.stored.set(session.id, session);
  }

  public async append(session: AgentSession, expectedSequence: number): Promise<void> {
    this.events.push(`session:${session.history.at(-1)?.kind}`);
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('injected Session event persistence failure');
    }
    const current = this.stored.get(session.id);
    if (current?.history.length !== expectedSequence) {
      throw new Error('stale Session revision');
    }
    this.stored.set(session.id, session);
  }

  public async listActive(): Promise<readonly AgentSession[]> {
    return [...this.stored.values()].filter(
      (session) => session.status !== 'EXITED' && session.status !== 'FAILED',
    );
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return [...this.stored.values()].filter((session) => session.taskId === taskId);
  }
}

class FakeAgentAdapter implements AgentAdapter {
  public readonly identity: AgentIdentity;
  public failure: Error | undefined;
  public readonly requests: AgentLaunchRequest[] = [];

  public constructor(
    private readonly events: string[],
    id = 'codex',
    private readonly executablePath = `C:\\tools\\${id}.exe`,
  ) {
    this.identity = Object.freeze({ displayName: id, id });
  }

  public async inspect(): Promise<never> {
    throw new Error('inspection is not part of start execution');
  }

  public async buildLaunchCommand(request: AgentLaunchRequest) {
    this.requests.push(request);
    this.events.push(`adapter:${request.workingDirectory}`);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return {
      arguments: ['--cd', request.workingDirectory],
      environment: request.environment,
      executablePath: this.executablePath,
      workingDirectory: request.workingDirectory,
    };
  }
}

class FakePtyHandle implements PtyHandle {
  public readonly dispose = vi.fn(async () => undefined);
  public readonly terminate = vi.fn(async () => undefined);
  public async resize(): Promise<void> {}
  public async write(): Promise<void> {}
}

class FakePtyRuntime implements PtyRuntime {
  public failure: PtyRuntimeError | undefined;
  public readonly handles: FakePtyHandle[] = [];
  public readonly specs: PtyLaunchSpec[] = [];
  private readonly sinks: PtyRuntimeEventSink[] = [];

  public constructor(private readonly events: string[]) {}

  public async open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle> {
    this.events.push(`pty:${spec.workingDirectory}`);
    this.specs.push(spec);
    this.sinks.push(sink);
    if (this.failure !== undefined) {
      sink({ kind: 'failed', operation: 'spawn', reason: this.failure.reason, sequence: 1 });
      throw this.failure;
    }
    const handle = new FakePtyHandle();
    this.handles.push(handle);
    sink({ kind: 'started', sequence: 1 });
    return handle;
  }

  public emit(index: number, event: PtyRuntimeEvent): void {
    this.sinks[index]?.(event);
  }
}

function taskAt(phase: TaskPhaseValue): Task {
  let task = createTask({ id: primaryWorktree.taskId, projectId: project.id, title: 'Execute' });
  while (task.phase !== phase) {
    const next = {
      BACKLOG: TaskPhase.PLANNING,
      PLANNING: TaskPhase.RUNNING,
      RUNNING: TaskPhase.REVIEW,
      REVIEW: TaskPhase.DONE,
      DONE: undefined,
    }[task.phase];
    if (next === undefined) {
      throw new Error(`Cannot reach ${phase}.`);
    }
    task = transitionTask(task, next);
  }
  return task;
}

function createFixture(phase: TaskPhaseValue = TaskPhase.RUNNING) {
  const events: string[] = [];
  const tasks = new MemoryTaskRepository([taskAt(phase)], events);
  const taskDependencies = new MemoryTaskDependencyRepository();
  const localProjects = new MemoryLocalProjectLocator(project);
  const worktrees = new MemoryTaskWorktreeRepository(events);
  const git = new MemoryGitWorktreeLifecycle(events);
  const sessionRepository = new MemoryAgentSessionRepository(events);
  const adapter = new FakeAgentAdapter(events);
  const otherAdapter = new FakeAgentAdapter(events, 'other-agent');
  const agents = new ConfiguredAgentCatalog([adapter, otherAdapter]);
  const runtime = new FakePtyRuntime(events);
  let now = 1_800_000_000_000;
  const sessionCoordinator = new AgentSessionCoordinator({
    agents,
    clock: () => now++,
    runtime,
    sessions: sessionRepository,
    tasks,
  });
  const dependencies = {
    git,
    localProjects,
    sessionCoordinator,
    taskDependencies,
    tasks,
    worktrees,
  };
  return {
    adapter,
    agents,
    dependencies,
    events,
    git,
    otherAdapter,
    runtime,
    sessionCoordinator,
    sessionRepository,
    taskDependencies,
    tasks,
    worktrees,
  };
}

describe('startTaskExecution', () => {
  it.each([
    ['execution', TaskPhase.RUNNING, startTaskExecution],
    ['planning', TaskPhase.PLANNING, startTaskPlanning],
  ] as const)(
    'blocks %s before Worktree mutation while a dependency is incomplete',
    async (_label, phase, start) => {
      const fixture = createFixture(phase);
      const required = createTask({
        id: 'task-required',
        projectId: project.id,
        title: 'Required first',
      });
      fixture.tasks.replace(required);
      fixture.taskDependencies.dependencies.push(
        createTaskDependency({ dependencyTaskId: required.id, taskId: primaryWorktree.taskId }),
      );

      await expect(start(executionInput, fixture.dependencies)).rejects.toMatchObject({
        blockingTaskIds: ['task-required'],
        name: 'TaskDependencyBlockedError',
        taskId: primaryWorktree.taskId,
      });
      expect(fixture.git.ensureCalls).toBe(0);
      await expect(fixture.sessionRepository.listByTaskId(primaryWorktree.taskId)).resolves.toEqual(
        [],
      );
    },
  );

  it('rejects PLANNING because only the explicit planning workflow may run in that phase', async () => {
    const fixture = createFixture(TaskPhase.PLANNING);

    await expect(startTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
      name: 'TaskExecutionPhaseError',
      phase: TaskPhase.PLANNING,
    });

    expect(fixture.git.ensureCalls).toBe(0);
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('rejects an unknown Agent before reading Task or Git state', async () => {
    const fixture = createFixture();

    await expect(
      startTaskExecution({ ...executionInput, agentId: 'missing-agent' }, fixture.dependencies),
    ).rejects.toBeInstanceOf(AgentNotConfiguredError);

    expect(fixture.events).toEqual([]);
    expect(fixture.git.ensureCalls).toBe(0);
    expect(fixture.worktrees.record).toBeUndefined();
  });

  it('selects the requested configured Agent without provider branching', async () => {
    const fixture = createFixture();

    const execution = await startTaskExecution(
      { ...executionInput, agentId: 'other-agent' },
      fixture.dependencies,
    );

    expect(execution.session.agentId).toBe('other-agent');
    expect(fixture.adapter.requests).toEqual([]);
    expect(fixture.otherAdapter.requests).toHaveLength(1);
    expect(fixture.runtime.specs[0]?.executablePath).toBe('C:\\tools\\other-agent.exe');
  });

  it.each([TaskPhase.BACKLOG, TaskPhase.REVIEW, TaskPhase.DONE])(
    'rejects %s before provisioning a Worktree or creating a Session',
    async (phase) => {
      const fixture = createFixture(phase);

      await expect(startTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
        name: 'TaskExecutionPhaseError',
        phase,
        taskId: executionInput.taskId,
      });

      expect(fixture.events).toEqual([]);
      expect(fixture.worktrees.record).toBeUndefined();
      await expect(fixture.sessionRepository.listByTaskId(primaryWorktree.taskId)).resolves.toEqual(
        [],
      );
    },
  );

  it('rejects a missing Task before any Git or Session side effect', async () => {
    const fixture = createFixture();
    const missingTasks = new MemoryTaskRepository([], fixture.events);

    await expect(
      startTaskExecution(executionInput, {
        ...fixture.dependencies,
        tasks: missingTasks,
      }),
    ).rejects.toMatchObject({ entity: 'Task', id: executionInput.taskId });

    expect(fixture.events).toEqual([]);
    expect(fixture.worktrees.record).toBeUndefined();
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('rejects a blank new Session identity before provisioning a Worktree', async () => {
    const fixture = createFixture();

    await expect(
      startTaskExecution({ ...executionInput, sessionId: '   ' }, fixture.dependencies),
    ).rejects.toThrow('Agent Session id must not be blank.');

    expect(fixture.events).toEqual([]);
    expect(fixture.worktrees.record).toBeUndefined();
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('launches from RUNNING in the primary Worktree without changing Task phase', async () => {
    const fixture = createFixture();
    const observedEvents: PtyRuntimeEvent[] = [];

    const execution = await startTaskExecution(
      { ...executionInput, eventSink: (event) => observedEvents.push(event) },
      fixture.dependencies,
    );

    expect(execution).toMatchObject({
      session: { id: executionInput.sessionId, status: AgentSessionStatus.WORKING },
      task: { id: executionInput.taskId, phase: TaskPhase.RUNNING },
      worktree: { kind: 'created', worktree: primaryWorktree },
    });
    expect(fixture.events).toEqual([
      'git:inspect',
      'worktree:PROVISIONING',
      'git:ensure',
      'worktree:PROVISIONING->PRESENT',
      'session:STARTING',
      `adapter:${primaryWorktree.worktreePath}`,
      `pty:${primaryWorktree.worktreePath}`,
      'session:STATUS_REPORTED',
    ]);
    expect(fixture.runtime.specs).toEqual([
      {
        arguments: ['--cd', primaryWorktree.worktreePath],
        environment: executionInput.environment,
        executablePath: 'C:\\tools\\codex.exe',
        initialSize: executionInput.initialSize,
        workingDirectory: primaryWorktree.worktreePath,
      },
    ]);
    expect(observedEvents).toEqual([{ kind: 'started', sequence: 1 }]);
  });

  it('requires the explicit Retry action after an exited Session', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
    await fixture.sessionCoordinator.findById(executionInput.sessionId);

    const eventsBeforeRestart = [...fixture.events];
    await expect(
      startTaskExecution({ ...executionInput, sessionId: 'session-2' }, fixture.dependencies),
    ).rejects.toMatchObject({
      name: 'TaskExecutionRetryError',
      reason: 'RETRY_REQUIRED',
    });

    expect(fixture.events).toEqual(eventsBeforeRestart);
    expect(fixture.git.ensureCalls).toBe(1);
    expect(fixture.tasks.update).not.toHaveBeenCalled();
    await expect(
      fixture.sessionRepository.listByTaskId(executionInput.taskId),
    ).resolves.toHaveLength(1);
  });

  it('rejects a second active Session before inspecting or changing the Worktree', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    const eventsBeforeDuplicate = [...fixture.events];

    await expect(
      startTaskExecution({ ...executionInput, sessionId: 'session-2' }, fixture.dependencies),
    ).rejects.toMatchObject({
      name: 'TaskExecutionRetryError',
      reason: 'ACTIVE_SESSION_EXISTS',
      sessionId: 'session-2',
      taskId: executionInput.taskId,
    });

    expect(fixture.events).toEqual(eventsBeforeDuplicate);
    expect(fixture.git.ensureCalls).toBe(1);
    expect(fixture.runtime.specs).toHaveLength(1);
  });

  it('keeps the Worktree provisioning checkpoint and creates no Session when Git fails', async () => {
    const fixture = createFixture();
    const gitFailure = new Error('injected Git failure');
    fixture.git.ensureFailure = gitFailure;

    await expect(startTaskExecution(executionInput, fixture.dependencies)).rejects.toBe(gitFailure);

    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.worktrees.record?.lifecycleState).toBe('PROVISIONING');
    expect(fixture.runtime.specs).toEqual([]);
    await expect(fixture.sessionRepository.listByTaskId(executionInput.taskId)).resolves.toEqual(
      [],
    );

    fixture.git.ensureFailure = undefined;
    const retried = await startTaskExecution(executionInput, fixture.dependencies);
    expect(retried.task.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.git.ensureCalls).toBe(2);
  });

  it('reuses a ready Worktree without rewriting the RUNNING Task', async () => {
    const fixture = createFixture();
    const started = await startTaskExecution(executionInput, fixture.dependencies);

    expect(started.task.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.worktrees.record?.lifecycleState).toBe('PRESENT');
    expect(fixture.runtime.specs).toHaveLength(1);
    expect(fixture.tasks.update).not.toHaveBeenCalled();
    expect(fixture.git.ensureCalls).toBe(1);
  });

  it('does not undo a concurrently admitted Review after Worktree inspection', async () => {
    const fixture = createFixture();
    fixture.git.onEnsure = () => fixture.tasks.replace(taskAt(TaskPhase.REVIEW));

    await expect(startTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
      cause: { name: 'TaskExecutionPhaseError', phase: TaskPhase.REVIEW },
      stage: 'TASK_STATE',
      taskId: executionInput.taskId,
    });

    await expect(fixture.tasks.findById(executionInput.taskId)).resolves.toMatchObject({
      phase: TaskPhase.REVIEW,
    });
    expect(fixture.runtime.specs).toEqual([]);
    await expect(fixture.sessionRepository.listByTaskId(executionInput.taskId)).resolves.toEqual(
      [],
    );
  });

  it('keeps RUNNING and the Worktree when initial Session persistence fails before spawn', async () => {
    const fixture = createFixture();
    fixture.sessionRepository.failInsert = true;

    const failure = await startTaskExecution(executionInput, fixture.dependencies).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      session: undefined,
      stage: 'SESSION_START',
      worktree: { worktree: primaryWorktree },
    });
    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.worktrees.record?.lifecycleState).toBe('PRESENT');
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('preserves a failed Session and requires a new Session id after Codex launch fails', async () => {
    const fixture = createFixture();
    const adapterFailure = new AgentAdapterError('EXECUTABLE_NOT_FOUND');
    fixture.adapter.failure = adapterFailure;

    const failure = await startTaskExecution(executionInput, fixture.dependencies).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TaskExecutionStartError);
    expect(failure).toMatchObject({
      cause: adapterFailure,
      session: { id: 'session-1', status: AgentSessionStatus.FAILED },
      stage: 'SESSION_START',
      worktree: { worktree: primaryWorktree },
    });
    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.runtime.specs).toEqual([]);

    fixture.adapter.failure = undefined;
    const eventsBeforeDuplicate = [...fixture.events];
    await expect(startTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
      entity: 'AgentSession',
      id: executionInput.sessionId,
      name: 'EntityAlreadyExistsError',
    });
    expect(fixture.events).toEqual(eventsBeforeDuplicate);

    const retried = await retryTaskExecution(
      { ...executionInput, sessionId: 'session-2' },
      fixture.dependencies,
    );
    expect(retried.worktree.kind).toBe('reused');
    await expect(
      fixture.sessionRepository.listByTaskId(executionInput.taskId),
    ).resolves.toMatchObject([
      { id: 'session-1', status: AgentSessionStatus.FAILED },
      { id: 'session-2', status: AgentSessionStatus.WORKING },
    ]);
  });

  it('records PTY spawn failure without rolling back RUNNING or the Worktree', async () => {
    const fixture = createFixture();
    const runtimeFailure = new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
    fixture.runtime.failure = runtimeFailure;

    const failure = await startTaskExecution(executionInput, fixture.dependencies).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      cause: runtimeFailure,
      session: { status: AgentSessionStatus.FAILED },
      stage: 'SESSION_START',
    });
    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.worktrees.record?.lifecycleState).toBe('PRESENT');
  });

  it('surfaces post-spawn Session persistence failure and requests safe runtime termination', async () => {
    const fixture = createFixture();
    fixture.sessionRepository.failNextAppend = true;

    const failure = await startTaskExecution(executionInput, fixture.dependencies).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      cause: { name: 'AgentSessionPersistenceError', sessionId: executionInput.sessionId },
      stage: 'SESSION_START',
    });
    expect(fixture.runtime.handles[0]?.terminate).toHaveBeenCalledTimes(1);
    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.RUNNING);
    expect(fixture.worktrees.record?.lifecycleState).toBe('PRESENT');
  });

  it('keeps Task RUNNING when the Agent process exits', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);

    fixture.runtime.emit(0, { exitCode: 17, kind: 'exited', sequence: 2 });

    await expect(
      fixture.sessionCoordinator.findById(executionInput.sessionId),
    ).resolves.toMatchObject({ status: AgentSessionStatus.EXITED });
    await expect(fixture.tasks.findById(executionInput.taskId)).resolves.toMatchObject({
      phase: TaskPhase.RUNNING,
    });
  });
});

describe('startTaskPlanning', () => {
  it('launches the selected Agent in a primary Worktree while Task stays PLANNING', async () => {
    const fixture = createFixture(TaskPhase.PLANNING);

    const result = await startTaskPlanning(executionInput, fixture.dependencies);

    expect(result).toMatchObject({
      previousSession: undefined,
      session: { agentId: 'codex', id: 'session-1', status: AgentSessionStatus.WORKING },
      task: { phase: TaskPhase.PLANNING },
      worktree: { kind: 'created', worktree: primaryWorktree },
    });
    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.PLANNING);
    expect(fixture.runtime.specs[0]).toMatchObject({
      workingDirectory: primaryWorktree.worktreePath,
    });
  });

  it('re-plans with a new AgentSession and reuses dirty Worktree history', async () => {
    const fixture = createFixture(TaskPhase.PLANNING);
    await startTaskPlanning(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
    await fixture.sessionCoordinator.findById(executionInput.sessionId);

    const revised = await startTaskPlanning(
      { ...executionInput, agentId: 'other-agent', sessionId: 'session-2' },
      fixture.dependencies,
    );

    expect(revised).toMatchObject({
      previousSession: { agentId: 'codex', id: 'session-1', status: AgentSessionStatus.EXITED },
      session: { agentId: 'other-agent', id: 'session-2', status: AgentSessionStatus.WORKING },
      task: { phase: TaskPhase.PLANNING },
      worktree: { kind: 'reused', worktree: primaryWorktree },
    });
    expect(fixture.git.ensureCalls).toBe(1);
    await expect(
      fixture.sessionRepository.listByTaskId(executionInput.taskId),
    ).resolves.toMatchObject([{ id: 'session-1' }, { id: 'session-2' }]);
  });

  it.each([TaskPhase.BACKLOG, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE])(
    'rejects planning from Task phase %s before Git mutation',
    async (phase) => {
      const fixture = createFixture(phase);

      await expect(startTaskPlanning(executionInput, fixture.dependencies)).rejects.toMatchObject({
        name: 'TaskPlanningPhaseError',
        phase,
      });

      expect(fixture.git.ensureCalls).toBe(0);
      expect(fixture.runtime.specs).toEqual([]);
    },
  );
});

describe('retryTaskExecution', () => {
  it.each([TaskPhase.BACKLOG, TaskPhase.REVIEW, TaskPhase.DONE])(
    'rejects retry from Task phase %s before inspecting Git',
    async (phase) => {
      const fixture = createFixture(phase);
      const starting = createAgentSession({
        agentId: 'codex',
        createdAt: 1_800_000_000_000,
        id: 'session-old',
        taskId: executionInput.taskId,
      });
      const exited = recordAgentSessionEvent(starting, {
        exitCode: 0,
        kind: 'PROCESS_EXITED',
        occurredAt: 1_800_000_000_001,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 1,
      });
      await fixture.sessionRepository.insert(starting);
      await fixture.sessionRepository.append(exited, 1);
      fixture.events.length = 0;

      await expect(retryTaskExecution(retryInput, fixture.dependencies)).rejects.toMatchObject({
        name: 'TaskExecutionPhaseError',
        phase,
        taskId: executionInput.taskId,
      });

      expect(fixture.events).toEqual([]);
      expect(fixture.git.ensureCalls).toBe(0);
    },
  );

  it('requires a previous FAILED or EXITED Session before touching Git', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);

    await expect(retryTaskExecution(retryInput, fixture.dependencies)).rejects.toEqual(
      new TaskExecutionRetryError(
        'NO_RETRYABLE_SESSION',
        executionInput.taskId,
        executionInput.sessionId,
      ),
    );

    expect(fixture.events).toEqual([]);
    expect(fixture.git.ensureCalls).toBe(0);
  });

  it('blocks retry before reusing the Worktree when a newly required Task is incomplete', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
    await fixture.sessionCoordinator.findById(executionInput.sessionId);
    const required = createTask({
      id: 'task-required-before-retry',
      projectId: project.id,
      title: 'Required before retry',
    });
    fixture.tasks.replace(required);
    fixture.taskDependencies.dependencies.push(
      createTaskDependency({
        dependencyTaskId: required.id,
        taskId: primaryWorktree.taskId,
      }),
    );

    await expect(
      retryTaskExecution({ ...retryInput, sessionId: 'session-2' }, fixture.dependencies),
    ).rejects.toMatchObject({
      blockingTaskIds: [required.id],
      name: 'TaskDependencyBlockedError',
      taskId: primaryWorktree.taskId,
    });
    expect(fixture.git.ensureCalls).toBe(1);
    await expect(fixture.sessionRepository.listByTaskId(primaryWorktree.taskId)).resolves.toEqual([
      expect.objectContaining({ id: executionInput.sessionId, status: AgentSessionStatus.EXITED }),
    ]);
  });

  it('reuses the primary Worktree and creates a new Session after the prior one exits', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, { exitCode: 17, kind: 'exited', sequence: 2 });
    await fixture.sessionCoordinator.findById(executionInput.sessionId);

    const retried = await retryTaskExecution(
      { ...retryInput, sessionId: 'session-2' },
      fixture.dependencies,
    );

    expect(retried).toMatchObject({
      previousSession: { id: 'session-1', status: AgentSessionStatus.EXITED },
      session: { id: 'session-2', status: AgentSessionStatus.WORKING },
      task: { phase: TaskPhase.RUNNING },
      worktree: { kind: 'reused', worktree: primaryWorktree },
    });
    expect(fixture.git.ensureCalls).toBe(1);
    await expect(
      fixture.sessionRepository.listByTaskId(executionInput.taskId),
    ).resolves.toMatchObject([
      { id: 'session-1', status: AgentSessionStatus.EXITED },
      { id: 'session-2', status: AgentSessionStatus.WORKING },
    ]);
  });

  it('rejects retry while an active Session exists without provisioning or launching again', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    const eventsBeforeRetry = [...fixture.events];

    await expect(
      retryTaskExecution({ ...retryInput, sessionId: 'session-2' }, fixture.dependencies),
    ).rejects.toMatchObject({
      activeSessionId: 'session-1',
      name: 'TaskExecutionRetryError',
      reason: 'ACTIVE_SESSION_EXISTS',
    });

    expect(fixture.events).toEqual(eventsBeforeRetry);
    expect(fixture.runtime.specs).toHaveLength(1);
  });

  it('rejects retry while a FAILED Session still has runtime ownership awaiting exit', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, {
      kind: 'failed',
      operation: 'runtime',
      reason: 'RUNTIME_FAILURE',
      sequence: 2,
    });
    await expect(fixture.sessionCoordinator.findById('session-1')).resolves.toMatchObject({
      status: AgentSessionStatus.FAILED,
    });
    const eventsBeforeRetry = [...fixture.events];

    await expect(
      retryTaskExecution({ ...retryInput, sessionId: 'session-2' }, fixture.dependencies),
    ).rejects.toMatchObject({
      activeSessionId: 'session-1',
      name: 'TaskExecutionRetryError',
      reason: 'ACTIVE_SESSION_EXISTS',
    });

    expect(fixture.events).toEqual(eventsBeforeRetry);
    expect(fixture.runtime.specs).toHaveLength(1);

    fixture.runtime.emit(0, { exitCode: -1, kind: 'exited', sequence: 3 });
    await fixture.sessionCoordinator.findById('session-1');
    await expect(
      retryTaskExecution({ ...retryInput, sessionId: 'session-2' }, fixture.dependencies),
    ).resolves.toMatchObject({
      previousSession: { id: 'session-1', status: AgentSessionStatus.FAILED },
      session: { id: 'session-2', status: AgentSessionStatus.WORKING },
    });
  });

  it('rejects retry when durable FAILED history has no exit or ownership-loss checkpoint', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);
    const starting = createAgentSession({
      agentId: 'codex',
      createdAt: 1_800_000_000_000,
      id: 'session-orphaned-runtime',
      taskId: executionInput.taskId,
    });
    const failed = recordAgentSessionEvent(starting, {
      code: 'RUNTIME_FAILURE',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: 1_800_000_000_001,
      runtimeSequence: 1,
      stage: 'RUNTIME',
    });
    await fixture.sessionRepository.insert(starting);
    await fixture.sessionRepository.append(failed, 1);
    fixture.events.length = 0;

    await expect(retryTaskExecution(retryInput, fixture.dependencies)).rejects.toMatchObject({
      activeSessionId: failed.id,
      name: 'TaskExecutionRetryError',
      reason: 'ACTIVE_SESSION_EXISTS',
    });

    expect(fixture.events).toEqual([]);
    expect(fixture.git.ensureCalls).toBe(0);
  });

  it('retries with the explicitly selected Agent and preserves the previous Agent identity', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);
    const previousStarting = createAgentSession({
      agentId: 'codex',
      createdAt: 1_800_000_000_000,
      id: 'session-codex',
      taskId: executionInput.taskId,
    });
    const previousExited = recordAgentSessionEvent(previousStarting, {
      exitCode: 0,
      kind: 'PROCESS_EXITED',
      occurredAt: 1_800_000_000_001,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 1,
    });
    await fixture.sessionRepository.insert(previousStarting);
    await fixture.sessionRepository.append(previousExited, 1);
    fixture.events.length = 0;

    const retried = await retryTaskExecution(
      { ...retryInput, agentId: 'other-agent' },
      fixture.dependencies,
    );

    expect(retried.previousSession.agentId).toBe('codex');
    expect(retried.session.agentId).toBe('other-agent');
    expect(fixture.adapter.requests).toEqual([]);
    expect(fixture.otherAdapter.requests).toHaveLength(1);
    expect(fixture.runtime.specs[0]?.executablePath).toBe('C:\\tools\\other-agent.exe');
  });

  it('allows retry with a configured Agent when the historical Agent is no longer configured', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);
    const starting = createAgentSession({
      agentId: 'removed-agent',
      createdAt: 1_800_000_000_000,
      id: 'session-removed-agent',
      taskId: executionInput.taskId,
    });
    const exited = recordAgentSessionEvent(starting, {
      exitCode: 0,
      kind: 'PROCESS_EXITED',
      occurredAt: 1_800_000_000_001,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 1,
    });
    await fixture.sessionRepository.insert(starting);
    await fixture.sessionRepository.append(exited, 1);
    fixture.events.length = 0;

    const retried = await retryTaskExecution(retryInput, fixture.dependencies);

    expect(retried.previousSession.agentId).toBe('removed-agent');
    expect(retried.session.agentId).toBe('codex');
    expect(fixture.git.ensureCalls).toBe(1);
  });

  it('rejects an unknown selected Agent before touching Task or Git state', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);

    await expect(
      retryTaskExecution({ ...retryInput, agentId: 'missing-agent' }, fixture.dependencies),
    ).rejects.toBeInstanceOf(AgentNotConfiguredError);

    expect(fixture.events).toEqual([]);
    expect(fixture.git.ensureCalls).toBe(0);
  });

  it('preserves both failed attempts so a later explicit retry can succeed', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, { exitCode: 1, kind: 'exited', sequence: 2 });
    await fixture.sessionCoordinator.findById(executionInput.sessionId);
    fixture.adapter.failure = new AgentAdapterError('EXECUTABLE_NOT_FOUND');

    const failure = await retryTaskExecution(
      { ...retryInput, sessionId: 'session-2' },
      fixture.dependencies,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      session: { id: 'session-2', status: AgentSessionStatus.FAILED },
      stage: 'SESSION_START',
    });
    fixture.adapter.failure = undefined;
    const recovered = await retryTaskExecution(
      { ...retryInput, sessionId: 'session-3' },
      fixture.dependencies,
    );
    expect(recovered.session).toMatchObject({
      id: 'session-3',
      status: AgentSessionStatus.WORKING,
    });
    await expect(
      fixture.sessionRepository.listByTaskId(executionInput.taskId),
    ).resolves.toMatchObject([
      { id: 'session-1', status: AgentSessionStatus.EXITED },
      { id: 'session-2', status: AgentSessionStatus.FAILED },
      { id: 'session-3', status: AgentSessionStatus.WORKING },
    ]);
  });
});
