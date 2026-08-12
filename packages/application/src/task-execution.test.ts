import { describe, expect, it, vi } from 'vitest';

import {
  AgentSessionStatus,
  TaskPhase,
  createAgentSession,
  createTask,
  recordAgentSessionEvent,
  transitionTask,
  type AgentSession,
  type Task,
  type TaskPhase as TaskPhaseValue,
} from '@agentterm/domain';

import {
  AgentAdapterError,
  AgentSessionCoordinator,
  PtyRuntimeError,
  TaskExecutionRetryError,
  TaskExecutionStartError,
  retryTaskExecution,
  startTaskExecution,
  type AgentAdapter,
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
  environment: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\AgentTerm' },
  initialSize: { columns: 120, rows: 36 },
  sessionId: 'session-1',
  taskId: primaryWorktree.taskId,
});

class MemoryTaskRepository implements TaskRepository {
  private readonly stored = new Map<string, Task>();
  public failNextUpdate = false;
  public readonly update = vi.fn(async (task: Task) => {
    this.events.push(`task:${task.phase}`);
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('injected Task persistence failure');
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
  public failure: Error | undefined;
  public readonly requests: AgentLaunchRequest[] = [];

  public constructor(private readonly events: string[]) {}

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
      executablePath: 'C:\\tools\\codex.exe',
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

function createFixture(phase: TaskPhaseValue = TaskPhase.PLANNING) {
  const events: string[] = [];
  const tasks = new MemoryTaskRepository([taskAt(phase)], events);
  const localProjects = new MemoryLocalProjectLocator(project);
  const worktrees = new MemoryTaskWorktreeRepository(events);
  const git = new MemoryGitWorktreeLifecycle(events);
  const sessionRepository = new MemoryAgentSessionRepository(events);
  const adapter = new FakeAgentAdapter(events);
  const runtime = new FakePtyRuntime(events);
  let now = 1_800_000_000_000;
  const sessionCoordinator = new AgentSessionCoordinator({
    adapter,
    agentId: 'codex',
    clock: () => now++,
    runtime,
    sessions: sessionRepository,
    tasks,
  });
  const dependencies = { git, localProjects, sessionCoordinator, tasks, worktrees };
  return {
    adapter,
    dependencies,
    events,
    git,
    runtime,
    sessionCoordinator,
    sessionRepository,
    tasks,
    worktrees,
  };
}

describe('startTaskExecution', () => {
  it.each([TaskPhase.BACKLOG, TaskPhase.REVIEW, TaskPhase.DONE])(
    'rejects %s before provisioning a Worktree or creating a Session',
    async (phase) => {
      const fixture = createFixture(phase);

      await expect(startTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
        name: 'InvalidTaskPhaseTransitionError',
        to: TaskPhase.RUNNING,
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

  it('provisions before RUNNING and launches the Session in the primary Worktree', async () => {
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
      'task:RUNNING',
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
    expect(fixture.tasks.update).toHaveBeenCalledTimes(1);
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

    expect((await fixture.tasks.findById(executionInput.taskId))?.phase).toBe(TaskPhase.PLANNING);
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

  it('preserves a ready Worktree and starts no process when Task persistence fails', async () => {
    const fixture = createFixture();
    fixture.tasks.failNextUpdate = true;

    const failure = await startTaskExecution(executionInput, fixture.dependencies).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(TaskExecutionStartError);
    expect(failure).toMatchObject({
      sessionId: executionInput.sessionId,
      stage: 'TASK_STATE',
      taskId: executionInput.taskId,
      worktree: { worktree: primaryWorktree },
    });
    expect(fixture.worktrees.record?.lifecycleState).toBe('PRESENT');
    expect(fixture.runtime.specs).toEqual([]);
    await expect(fixture.sessionRepository.listByTaskId(executionInput.taskId)).resolves.toEqual(
      [],
    );

    const retried = await startTaskExecution(executionInput, fixture.dependencies);
    expect(retried.worktree.kind).toBe('reused');
    expect(fixture.git.ensureCalls).toBe(1);
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

      await expect(retryTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
        name: 'InvalidTaskPhaseTransitionError',
        to: TaskPhase.RUNNING,
      });

      expect(fixture.events).toEqual([]);
      expect(fixture.git.ensureCalls).toBe(0);
    },
  );

  it('requires a previous FAILED or EXITED Session before touching Git', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);

    await expect(retryTaskExecution(executionInput, fixture.dependencies)).rejects.toEqual(
      new TaskExecutionRetryError(
        'NO_RETRYABLE_SESSION',
        executionInput.taskId,
        executionInput.sessionId,
      ),
    );

    expect(fixture.events).toEqual([]);
    expect(fixture.git.ensureCalls).toBe(0);
  });

  it('reuses the primary Worktree and creates a new Session after the prior one exits', async () => {
    const fixture = createFixture();
    await startTaskExecution(executionInput, fixture.dependencies);
    fixture.runtime.emit(0, { exitCode: 17, kind: 'exited', sequence: 2 });
    await fixture.sessionCoordinator.findById(executionInput.sessionId);

    const retried = await retryTaskExecution(
      { ...executionInput, sessionId: 'session-2' },
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
      retryTaskExecution({ ...executionInput, sessionId: 'session-2' }, fixture.dependencies),
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
      retryTaskExecution({ ...executionInput, sessionId: 'session-2' }, fixture.dependencies),
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
      retryTaskExecution({ ...executionInput, sessionId: 'session-2' }, fixture.dependencies),
    ).resolves.toMatchObject({
      previousSession: { id: 'session-1', status: AgentSessionStatus.FAILED },
      session: { id: 'session-2', status: AgentSessionStatus.WORKING },
    });
  });

  it('rejects retry through a different agent coordinator without touching the Worktree', async () => {
    const fixture = createFixture(TaskPhase.RUNNING);
    const otherAgentStarting = createAgentSession({
      agentId: 'other-agent',
      createdAt: 1_800_000_000_000,
      id: 'session-other',
      taskId: executionInput.taskId,
    });
    const otherAgentExited = recordAgentSessionEvent(otherAgentStarting, {
      exitCode: 0,
      kind: 'PROCESS_EXITED',
      occurredAt: 1_800_000_000_001,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 1,
    });
    await fixture.sessionRepository.insert(otherAgentStarting);
    await fixture.sessionRepository.append(otherAgentExited, 1);
    fixture.events.length = 0;

    await expect(retryTaskExecution(executionInput, fixture.dependencies)).rejects.toMatchObject({
      name: 'TaskExecutionRetryError',
      reason: 'AGENT_MISMATCH',
    });

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
      { ...executionInput, sessionId: 'session-2' },
      fixture.dependencies,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      session: { id: 'session-2', status: AgentSessionStatus.FAILED },
      stage: 'SESSION_START',
    });
    fixture.adapter.failure = undefined;
    const recovered = await retryTaskExecution(
      { ...executionInput, sessionId: 'session-3' },
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
