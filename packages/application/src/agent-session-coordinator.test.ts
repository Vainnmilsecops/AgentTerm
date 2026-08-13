import { describe, expect, it, vi } from 'vitest';

import { AgentSessionStatus, createTask, type AgentSession, type Task } from '@agentterm/domain';

import {
  AgentAdapterError,
  AgentNotConfiguredError,
  AgentSessionCoordinator,
  AgentSessionTerminalAttachmentConflictError,
  AgentSessionPersistenceError,
  AgentSessionRuntimeOwnershipError,
  EntityAlreadyExistsError,
  PtyRuntimeError,
  ConfiguredAgentCatalog,
  type AgentAdapter,
  type AgentIdentity,
  type AgentLaunchRequest,
  type AgentSessionRepository,
  type PtyHandle,
  type PtyLaunchSpec,
  type PtyRuntime,
  type PtyRuntimeEvent,
  type PtyRuntimeEventSink,
  type TaskRepository,
} from './index';

const task = createTask({ id: 'task-1', projectId: 'project-1', title: 'Run Codex' });
const launchInput = {
  agentId: 'codex',
  environment: { SystemRoot: 'C:\\Windows' },
  initialSize: { columns: 100, rows: 30 },
  sessionId: 'session-1',
  taskId: task.id,
  workingDirectory: 'C:\\worktrees\\task-1',
};

class FakeTaskRepository implements TaskRepository {
  private readonly stored = new Map<string, Task>();
  public findCalls = 0;
  public readonly update = vi.fn(async (next: Task) => {
    this.stored.set(next.id, next);
  });

  public constructor(tasks: readonly Task[] = []) {
    for (const current of tasks) {
      this.stored.set(current.id, current);
    }
  }

  public async findById(id: string): Promise<Task | undefined> {
    this.findCalls += 1;
    return this.stored.get(id);
  }

  public async insert(current: Task): Promise<void> {
    this.stored.set(current.id, current);
  }
}

class FakeAgentSessionRepository implements AgentSessionRepository {
  private readonly stored = new Map<string, AgentSession>();
  public readonly operations: string[] = [];
  public failInsert = false;
  public failNextAppend = false;

  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.stored.get(id);
  }

  public async insert(session: AgentSession): Promise<void> {
    this.operations.push(`insert:${session.status}`);
    if (this.failInsert) {
      throw new Error('injected insert failure');
    }
    if (this.stored.has(session.id)) {
      throw new EntityAlreadyExistsError('AgentSession', session.id);
    }
    this.stored.set(session.id, session);
  }

  public async append(session: AgentSession, expectedSequence: number): Promise<void> {
    this.operations.push(`append:${session.history.at(-1)?.kind}`);
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('injected append failure');
    }
    const current = this.stored.get(session.id);
    if (current === undefined || current.history.length !== expectedSequence) {
      throw new Error('stale session revision');
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
  public readonly requests: AgentLaunchRequest[] = [];
  public failure: Error | undefined;
  public gate: Promise<void> | undefined;

  public constructor(
    id = 'codex',
    private readonly executablePath = `C:\\tools\\${id}.exe`,
  ) {
    this.identity = { displayName: id, id };
  }

  public async inspect(): Promise<never> {
    throw new Error('inspect is not used to start a session');
  }

  public async buildLaunchCommand(request: AgentLaunchRequest) {
    this.requests.push(request);
    await this.gate;
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
  public readonly terminate = vi.fn(async () => undefined);
  public readonly dispose = vi.fn(async () => undefined);
  public readonly write = vi.fn(async () => undefined);
  public readonly resize = vi.fn(async () => undefined);
}

class FakePtyRuntime implements PtyRuntime {
  public readonly handle = new FakePtyHandle();
  public readonly specs: PtyLaunchSpec[] = [];
  public onOpen: ((sink: PtyRuntimeEventSink, handle: FakePtyHandle) => void) | undefined;
  public openFailure: Error | undefined;
  private sink: PtyRuntimeEventSink | undefined;

  public async open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle> {
    this.specs.push(spec);
    this.sink = sink;
    this.onOpen?.(sink, this.handle);
    if (this.openFailure !== undefined) {
      throw this.openFailure;
    }
    return this.handle;
  }

  public emit(event: PtyRuntimeEvent): void {
    this.sink?.(event);
  }
}

function createFixture(options: { readonly taskExists?: boolean } = {}) {
  let now = 1_800_000_000_000;
  const adapter = new FakeAgentAdapter();
  const secondAdapter = new FakeAgentAdapter('second-agent');
  const agents = new ConfiguredAgentCatalog([adapter, secondAdapter]);
  const runtime = new FakePtyRuntime();
  const sessions = new FakeAgentSessionRepository();
  const tasks = new FakeTaskRepository(options.taskExists === false ? [] : [task]);
  const coordinator = new AgentSessionCoordinator({
    agents,
    clock: () => now++,
    runtime,
    sessions,
    tasks,
  });
  return { adapter, agents, coordinator, runtime, secondAdapter, sessions, tasks };
}

describe('AgentSessionCoordinator', () => {
  it('rejects an unknown Agent before reading the Task or creating a Session', async () => {
    const fixture = createFixture();

    await expect(
      fixture.coordinator.start({ ...launchInput, agentId: 'missing-agent' }),
    ).rejects.toBeInstanceOf(AgentNotConfiguredError);

    expect(fixture.tasks.findCalls).toBe(0);
    expect(fixture.sessions.operations).toEqual([]);
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('uses the immutable catalog identity when an adapter mutates its source descriptor', async () => {
    const fixture = createFixture();
    let releaseLaunch = (): void => undefined;
    fixture.adapter.gate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    const startAttempt = fixture.coordinator.start(launchInput);

    await vi.waitFor(() => expect(fixture.adapter.requests).toHaveLength(1));
    (fixture.adapter.identity as { id: string }).id = 'mutated-agent';
    releaseLaunch();

    expect(fixture.coordinator.isAgentConfigured('codex')).toBe(true);
    const session = await startAttempt;

    expect(session.agentId).toBe('codex');
    expect(fixture.adapter.requests).toHaveLength(1);
    expect(fixture.runtime.specs).toHaveLength(1);
  });

  it('selects the adapter by id and persists that exact identity', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });

    const session = await fixture.coordinator.start({
      ...launchInput,
      agentId: 'second-agent',
    });

    expect(session.agentId).toBe('second-agent');
    expect(fixture.adapter.requests).toEqual([]);
    expect(fixture.secondAdapter.requests).toHaveLength(1);
    expect(fixture.runtime.specs[0]?.executablePath).toBe('C:\\tools\\second-agent.exe');
  });

  it('rejects a missing Task before creating or launching a session', async () => {
    const fixture = createFixture({ taskExists: false });

    await expect(fixture.coordinator.start(launchInput)).rejects.toMatchObject({
      entity: 'Task',
      id: task.id,
      name: 'EntityNotFoundError',
    });
    expect(fixture.sessions.operations).toEqual([]);
    expect(fixture.adapter.requests).toEqual([]);
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('persists STARTING before the adapter and buffers synchronous started evidence', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => {
      expect(fixture.sessions.operations).toEqual(['insert:STARTING']);
      sink({ kind: 'started', sequence: 1 });
    };

    const session = await fixture.coordinator.start(launchInput);

    expect(session.status).toBe(AgentSessionStatus.WORKING);
    expect(session.history.map((event) => event.kind)).toEqual([
      'START_REQUESTED',
      'STATUS_REPORTED',
    ]);
    expect(fixture.adapter.requests).toEqual([
      {
        environment: launchInput.environment,
        workingDirectory: launchInput.workingDirectory,
      },
    ]);
    expect(fixture.runtime.specs).toEqual([
      {
        arguments: ['--cd', launchInput.workingDirectory],
        environment: launchInput.environment,
        executablePath: 'C:\\tools\\codex.exe',
        initialSize: launchInput.initialSize,
        workingDirectory: launchInput.workingDirectory,
      },
    ]);
    expect(fixture.tasks.update).not.toHaveBeenCalled();
    await expect(fixture.tasks.findById(task.id)).resolves.toEqual(task);
  });

  it('keeps every session created for one Task', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });

    await fixture.coordinator.start(launchInput);
    fixture.runtime.emit({ exitCode: 0, kind: 'exited', sequence: 2 });
    await fixture.coordinator.findById(launchInput.sessionId);
    await fixture.coordinator.start({ ...launchInput, sessionId: 'session-2' });

    await expect(fixture.coordinator.listByTaskId(task.id)).resolves.toMatchObject([
      { agentId: 'codex', id: 'session-1', taskId: task.id },
      { agentId: 'codex', id: 'session-2', taskId: task.id },
    ]);
  });

  it('rejects a second active Session for the same Task', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);

    await expect(
      fixture.coordinator.start({ ...launchInput, sessionId: 'session-2' }),
    ).rejects.toMatchObject({
      name: 'AgentSessionActiveConflictError',
      taskId: task.id,
    });

    await expect(fixture.coordinator.listByTaskId(task.id)).resolves.toHaveLength(1);
    expect(fixture.runtime.specs).toHaveLength(1);
  });

  it('forwards output and persists fatal failure followed by exit evidence without changing Task', async () => {
    const fixture = createFixture();
    const observed: PtyRuntimeEvent[] = [];
    fixture.runtime.onOpen = (sink) => {
      sink({ kind: 'started', sequence: 1 });
      sink({ data: 'hello', kind: 'output', sequence: 2 });
      sink({
        kind: 'failed',
        operation: 'runtime',
        reason: 'RUNTIME_FAILURE',
        sequence: 3,
      });
      sink({
        kind: 'failed',
        operation: 'cleanup',
        reason: 'RUNTIME_FAILURE',
        sequence: 4,
      });
      sink({ exitCode: -1, kind: 'exited', sequence: 5 });
    };

    const session = await fixture.coordinator.start({
      ...launchInput,
      eventSink: (event) => observed.push(event),
    });

    expect(observed.map((event) => event.kind)).toEqual([
      'started',
      'output',
      'failed',
      'failed',
      'exited',
    ]);
    expect(session.status).toBe(AgentSessionStatus.FAILED);
    expect(session.history.map((event) => event.kind)).toEqual([
      'START_REQUESTED',
      'STATUS_REPORTED',
      'RUNTIME_FAILED',
      'RUNTIME_FAILED',
      'PROCESS_EXITED',
    ]);
    expect(session.history.at(-1)?.status).toBe(AgentSessionStatus.FAILED);
    expect(fixture.tasks.update).not.toHaveBeenCalled();
    await expect(fixture.tasks.findById(task.id)).resolves.toEqual(task);
  });

  it.each([0, 17])(
    'records process exit code %s as EXITED evidence, not Task Done',
    async (exitCode) => {
      const fixture = createFixture();
      fixture.runtime.onOpen = (sink) => {
        sink({ kind: 'started', sequence: 1 });
        sink({ exitCode, kind: 'exited', sequence: 2 });
      };

      const session = await fixture.coordinator.start(launchInput);

      expect(session.status).toBe(AgentSessionStatus.EXITED);
      expect(session.history.at(-1)).toMatchObject({ exitCode, kind: 'PROCESS_EXITED' });
      await expect(fixture.tasks.findById(task.id)).resolves.toEqual(task);
    },
  );

  it('persists adapter launch failure without opening PTY', async () => {
    const fixture = createFixture();
    fixture.adapter.failure = new AgentAdapterError('EXECUTABLE_NOT_FOUND');

    await expect(fixture.coordinator.start(launchInput)).rejects.toBe(fixture.adapter.failure);
    await expect(fixture.coordinator.findById('session-1')).resolves.toMatchObject({
      history: expect.arrayContaining([
        expect.objectContaining({ code: 'EXECUTABLE_NOT_FOUND', kind: 'RUNTIME_FAILED' }),
      ]),
      status: AgentSessionStatus.FAILED,
    });
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('persists synchronous PTY launch failure once', async () => {
    const fixture = createFixture();
    fixture.runtime.openFailure = new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
    fixture.runtime.onOpen = (sink) =>
      sink({
        kind: 'failed',
        operation: 'spawn',
        reason: 'RUNTIME_FAILURE',
        sequence: 1,
      });

    await expect(fixture.coordinator.start(launchInput)).rejects.toBe(fixture.runtime.openFailure);
    const session = await fixture.coordinator.findById('session-1');
    expect(session?.status).toBe(AgentSessionStatus.FAILED);
    expect(session?.history.filter((event) => event.kind === 'RUNTIME_FAILED')).toEqual([
      expect.objectContaining({ runtimeSequence: 1, stage: 'START' }),
    ]);
  });

  it('does not launch when initial session persistence fails', async () => {
    const fixture = createFixture();
    fixture.sessions.failInsert = true;

    await expect(fixture.coordinator.start(launchInput)).rejects.toThrow('injected insert failure');
    expect(fixture.adapter.requests).toEqual([]);
    expect(fixture.runtime.specs).toEqual([]);
  });

  it('surfaces event persistence failure and terminates the owned runtime', async () => {
    const fixture = createFixture();
    fixture.sessions.failNextAppend = true;
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });

    await expect(fixture.coordinator.start(launchInput)).rejects.toBeInstanceOf(
      AgentSessionPersistenceError,
    );
    expect(fixture.runtime.handle.terminate).toHaveBeenCalledOnce();
    await expect(fixture.coordinator.findById('session-1')).rejects.toBeInstanceOf(
      AgentSessionPersistenceError,
    );
  });

  it('moves between explicit active states without PTY inference', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);

    await expect(
      fixture.coordinator.reportStatus({ sessionId: 'session-1', status: 'IDLE' }),
    ).resolves.toMatchObject({ status: 'IDLE' });
    await expect(
      fixture.coordinator.reportStatus({ sessionId: 'session-1', status: 'WAITING_INPUT' }),
    ).resolves.toMatchObject({ status: 'WAITING_INPUT' });
    await expect(
      fixture.coordinator.reportStatus({ sessionId: 'session-1', status: 'WORKING' }),
    ).resolves.toMatchObject({ status: 'WORKING' });
  });

  it('serializes an explicit status command with a runtime exit event', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);

    const idle = fixture.coordinator.reportStatus({ sessionId: 'session-1', status: 'IDLE' });
    fixture.runtime.emit({ exitCode: 0, kind: 'exited', sequence: 2 });

    await expect(idle).resolves.toMatchObject({ status: AgentSessionStatus.IDLE });
    await expect(fixture.coordinator.findById('session-1')).resolves.toMatchObject({
      history: expect.arrayContaining([
        expect.objectContaining({ kind: 'STATUS_REPORTED', status: 'IDLE' }),
        expect.objectContaining({ kind: 'PROCESS_EXITED', status: 'EXITED' }),
      ]),
      status: AgentSessionStatus.EXITED,
    });
  });

  it('persists stop intent before terminate and returns the exit event', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink, handle) => {
      sink({ kind: 'started', sequence: 1 });
      handle.terminate.mockImplementationOnce(async () => {
        expect(fixture.sessions.operations.at(-1)).toBe('append:STOP_REQUESTED');
        fixture.runtime.emit({ exitCode: 1, kind: 'exited', sequence: 2, signal: 15 });
      });
    };
    await fixture.coordinator.start(launchInput);

    const stopped = await fixture.coordinator.stop({ sessionId: 'session-1' });
    const duplicate = await fixture.coordinator.stop({ sessionId: 'session-1' });

    expect(stopped.status).toBe(AgentSessionStatus.EXITED);
    expect(stopped.history.at(-1)).toMatchObject({ kind: 'PROCESS_EXITED', reason: 'STOPPED' });
    expect(duplicate).toEqual(stopped);
    expect(fixture.runtime.handle.terminate).toHaveBeenCalledOnce();
  });

  it('records one nonfatal terminate failure and keeps the live session retryable', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink, handle) => {
      sink({ kind: 'started', sequence: 1 });
      handle.terminate.mockImplementationOnce(async () => {
        fixture.runtime.emit({
          kind: 'failed',
          operation: 'terminate',
          reason: 'RUNTIME_FAILURE',
          sequence: 2,
        });
        throw new PtyRuntimeError('terminate', 'RUNTIME_FAILURE');
      });
    };
    await fixture.coordinator.start(launchInput);

    await expect(fixture.coordinator.stop({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      PtyRuntimeError,
    );
    const session = await fixture.coordinator.findById('session-1');
    expect(session?.status).toBe(AgentSessionStatus.WORKING);
    expect(session?.history.filter((event) => event.kind === 'RUNTIME_FAILED')).toHaveLength(1);
    expect(fixture.runtime.handle.terminate).toHaveBeenCalledOnce();
  });

  it('stops an owned runtime after fatal failure while preserving FAILED status', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink, handle) => {
      sink({ kind: 'started', sequence: 1 });
      sink({
        kind: 'failed',
        operation: 'runtime',
        reason: 'RUNTIME_FAILURE',
        sequence: 2,
      });
      handle.terminate.mockImplementationOnce(async () => {
        fixture.runtime.emit({ exitCode: -1, kind: 'exited', sequence: 3 });
      });
    };
    await expect(fixture.coordinator.start(launchInput)).resolves.toMatchObject({
      status: AgentSessionStatus.FAILED,
    });

    const stopped = await fixture.coordinator.stop({ sessionId: 'session-1' });

    expect(stopped.status).toBe(AgentSessionStatus.FAILED);
    expect(stopped.history.at(-1)).toMatchObject({
      kind: 'PROCESS_EXITED',
      reason: 'STOPPED',
      status: AgentSessionStatus.FAILED,
    });
    expect(fixture.runtime.handle.terminate).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight start before stopping its newly owned runtime', async () => {
    const fixture = createFixture();
    let releaseLaunch!: () => void;
    fixture.adapter.gate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    fixture.runtime.onOpen = (sink, handle) => {
      sink({ kind: 'started', sequence: 1 });
      handle.terminate.mockImplementationOnce(async () => {
        fixture.runtime.emit({ exitCode: 1, kind: 'exited', sequence: 2, signal: 15 });
      });
    };

    const started = fixture.coordinator.start(launchInput);
    await vi.waitFor(() => expect(fixture.adapter.requests).toHaveLength(1));
    const stopped = fixture.coordinator.stop({ sessionId: 'session-1' });
    releaseLaunch();

    await expect(started).resolves.toMatchObject({ status: AgentSessionStatus.WORKING });
    await expect(stopped).resolves.toMatchObject({ status: AgentSessionStatus.EXITED });
    expect(fixture.runtime.handle.terminate).toHaveBeenCalledOnce();
  });

  it('refuses to stop a live persisted session whose runtime is not owned', async () => {
    const first = createFixture();
    first.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await first.coordinator.start(launchInput);
    const restarted = new AgentSessionCoordinator({
      agents: first.agents,
      clock: () => 1_800_000_000_100,
      runtime: first.runtime,
      sessions: first.sessions,
      tasks: first.tasks,
    });

    await expect(restarted.stop({ sessionId: 'session-1' })).rejects.toBeInstanceOf(
      AgentSessionRuntimeOwnershipError,
    );
    expect(first.runtime.handle.terminate).not.toHaveBeenCalled();
    await expect(restarted.findById('session-1')).resolves.toMatchObject({ status: 'WORKING' });
  });

  it('attaches a live terminal observer and forwards Unicode input and resize to the owned PTY', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);
    const observed: PtyRuntimeEvent[] = [];

    const attachment = await fixture.coordinator.attachTerminal({
      eventSink: (event) => observed.push(event),
      sessionId: 'session-1',
    });
    fixture.runtime.emit({ data: 'Xin chào 👋\r\n', kind: 'output', sequence: 2 });
    await attachment.write('gõ tiếng Việt 🚀\r');
    await attachment.resize({ columns: 101, rows: 31 });

    expect(observed).toEqual([{ data: 'Xin chào 👋\r\n', kind: 'output', sequence: 2 }]);
    expect(fixture.runtime.handle.write).toHaveBeenCalledWith('gõ tiếng Việt 🚀\r');
    expect(fixture.runtime.handle.resize).toHaveBeenCalledWith({ columns: 101, rows: 31 });
  });

  it('detaches a terminal idempotently without terminating the session runtime', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);
    const observed: PtyRuntimeEvent[] = [];
    const attachment = await fixture.coordinator.attachTerminal({
      eventSink: (event) => observed.push(event),
      sessionId: 'session-1',
    });

    attachment.detach();
    attachment.detach();
    fixture.runtime.emit({ data: 'not rendered', kind: 'output', sequence: 2 });

    expect(observed).toEqual([]);
    await expect(attachment.write('ignored')).rejects.toMatchObject({
      operation: 'write',
      reason: 'NOT_RUNNING',
    });
    await expect(attachment.resize({ columns: 80, rows: 24 })).rejects.toMatchObject({
      operation: 'resize',
      reason: 'NOT_RUNNING',
    });
    expect(fixture.runtime.handle.terminate).not.toHaveBeenCalled();
    expect(fixture.runtime.handle.dispose).not.toHaveBeenCalled();
  });

  it('allows only one interactive terminal attachment and releases ownership on detach', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);
    const firstObserved: PtyRuntimeEvent[] = [];
    const replacementObserved: PtyRuntimeEvent[] = [];

    const first = await fixture.coordinator.attachTerminal({
      eventSink: (event) => firstObserved.push(event),
      sessionId: 'session-1',
    });
    await expect(
      fixture.coordinator.attachTerminal({
        eventSink: (event) => replacementObserved.push(event),
        sessionId: 'session-1',
      }),
    ).rejects.toBeInstanceOf(AgentSessionTerminalAttachmentConflictError);

    fixture.runtime.emit({ data: 'first only', kind: 'output', sequence: 2 });
    first.detach();
    const replacement = await fixture.coordinator.attachTerminal({
      eventSink: (event) => replacementObserved.push(event),
      sessionId: 'session-1',
    });
    fixture.runtime.emit({ data: 'replacement only', kind: 'output', sequence: 3 });

    expect(firstObserved).toEqual([{ data: 'first only', kind: 'output', sequence: 2 }]);
    expect(replacementObserved).toEqual([
      { data: 'replacement only', kind: 'output', sequence: 3 },
    ]);
    expect(fixture.runtime.handle.terminate).not.toHaveBeenCalled();
    replacement.detach();
  });

  it('does not duplicate or remove a matching non-interactive launch observer', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    const observed: PtyRuntimeEvent[] = [];
    const eventSink = (event: PtyRuntimeEvent): void => {
      observed.push(event);
    };
    await fixture.coordinator.start({ ...launchInput, eventSink });

    const attachment = await fixture.coordinator.attachTerminal({
      eventSink,
      sessionId: 'session-1',
    });
    fixture.runtime.emit({ data: 'while attached', kind: 'output', sequence: 2 });
    attachment.detach();
    fixture.runtime.emit({ data: 'after detach', kind: 'output', sequence: 3 });

    expect(observed).toEqual([
      { kind: 'started', sequence: 1 },
      { data: 'while attached', kind: 'output', sequence: 2 },
      { data: 'after detach', kind: 'output', sequence: 3 },
    ]);
  });

  it('closes terminal input on process exit without changing the Task phase', async () => {
    const fixture = createFixture();
    fixture.runtime.onOpen = (sink) => sink({ kind: 'started', sequence: 1 });
    await fixture.coordinator.start(launchInput);
    const observed: PtyRuntimeEvent[] = [];
    const attachment = await fixture.coordinator.attachTerminal({
      eventSink: (event) => observed.push(event),
      sessionId: 'session-1',
    });

    fixture.runtime.emit({ exitCode: 0, kind: 'exited', sequence: 2 });

    await expect(attachment.write('after exit')).rejects.toMatchObject({
      operation: 'write',
      reason: 'NOT_RUNNING',
    });
    expect(observed).toEqual([{ exitCode: 0, kind: 'exited', sequence: 2 }]);
    expect(fixture.tasks.update).not.toHaveBeenCalled();
    await expect(fixture.tasks.findById(task.id)).resolves.toEqual(task);
  });

  it('refuses terminal attachment when this coordinator does not own a live runtime', async () => {
    const fixture = createFixture();

    await expect(
      fixture.coordinator.attachTerminal({ eventSink: () => undefined, sessionId: 'session-1' }),
    ).rejects.toBeInstanceOf(AgentSessionRuntimeOwnershipError);
  });
});
