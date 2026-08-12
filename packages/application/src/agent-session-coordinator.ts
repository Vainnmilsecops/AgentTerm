import {
  AgentSessionStatus,
  createAgentSession,
  recordAgentSessionEvent,
  type AgentSession,
  type AgentSessionActiveStatus,
  type AgentSessionFailureStage,
} from '@agentterm/domain';

import {
  AgentAdapterError,
  AgentSessionActiveConflictError,
  AgentSessionPersistenceError,
  AgentSessionRuntimeOwnershipError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  PtyRuntimeError,
} from './errors';
import type {
  AgentAdapter,
  AgentSessionRepository,
  PtyHandle,
  PtyRuntime,
  PtyRuntimeEvent,
  PtyRuntimeEventSink,
  PtyTerminalSize,
  TaskRepository,
} from './ports';

export interface StartAgentSessionInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly eventSink?: PtyRuntimeEventSink;
  readonly initialSize: PtyTerminalSize;
  readonly sessionId: string;
  readonly taskId: string;
  readonly workingDirectory: string;
}

export interface StopAgentSessionInput {
  readonly sessionId: string;
}

export interface ReportAgentSessionStatusInput {
  readonly sessionId: string;
  readonly status: AgentSessionActiveStatus;
}

export interface AttachAgentSessionTerminalInput {
  readonly eventSink: PtyRuntimeEventSink;
  readonly sessionId: string;
}

export interface AgentSessionTerminalAttachment {
  /** Stops observing this runtime without stopping the Agent Session process. */
  detach(): void;
  resize(size: PtyTerminalSize): Promise<void>;
  write(input: string): Promise<void>;
}

export interface AgentSessionCoordinatorDependencies {
  readonly adapter: AgentAdapter;
  readonly agentId: string;
  readonly clock: () => number;
  readonly runtime: PtyRuntime;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
}

interface OwnedSessionRuntime {
  acceptingTerminalInput: boolean;
  failure: AgentSessionPersistenceError | undefined;
  handle: PtyHandle | undefined;
  readonly observers: Set<PtyRuntimeEventSink>;
  readonly runtimeEvents: Map<number, string>;
  stopAttempt: Promise<AgentSession> | undefined;
  stopRequested: boolean;
  tail: Promise<void>;
}

export class AgentSessionCoordinator {
  private readonly adapter: AgentAdapter;
  public readonly agentId: string;
  private readonly clock: () => number;
  private readonly runtime: PtyRuntime;
  private readonly sessions: AgentSessionRepository;
  private readonly tasks: TaskRepository;
  private readonly ownedRuntimes = new Map<string, OwnedSessionRuntime>();
  private readonly starts = new Map<string, Promise<AgentSession>>();

  public constructor(dependencies: AgentSessionCoordinatorDependencies) {
    this.adapter = dependencies.adapter;
    this.agentId = dependencies.agentId;
    this.clock = dependencies.clock;
    this.runtime = dependencies.runtime;
    this.sessions = dependencies.sessions;
    this.tasks = dependencies.tasks;
  }

  public start(input: StartAgentSessionInput): Promise<AgentSession> {
    const inFlight = this.starts.get(input.sessionId);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const attempt = this.startOnce(input);
    this.starts.set(input.sessionId, attempt);
    void attempt
      .finally(() => {
        if (this.starts.get(input.sessionId) === attempt) {
          this.starts.delete(input.sessionId);
        }
      })
      .catch(() => undefined);
    return attempt;
  }

  public async stop(input: StopAgentSessionInput): Promise<AgentSession> {
    let runtimeState = this.ownedRuntimes.get(input.sessionId);
    const inFlightStart = this.starts.get(input.sessionId);
    if (runtimeState === undefined && inFlightStart !== undefined) {
      await inFlightStart;
      runtimeState = this.ownedRuntimes.get(input.sessionId);
    }
    if (runtimeState?.stopAttempt !== undefined) {
      return runtimeState.stopAttempt;
    }

    const attempt = this.stopOnce(input.sessionId, runtimeState);
    if (runtimeState !== undefined) {
      runtimeState.stopAttempt = attempt;
      void attempt
        .finally(() => {
          if (runtimeState.stopAttempt === attempt) {
            runtimeState.stopAttempt = undefined;
          }
        })
        .catch(() => undefined);
    }
    return attempt;
  }

  public async reportStatus(input: ReportAgentSessionStatusInput): Promise<AgentSession> {
    const runtimeState = this.ownedRuntimes.get(input.sessionId);
    return this.runSerialized(runtimeState, async () => {
      const current = await this.requireSession(input.sessionId);
      const next = recordAgentSessionEvent(current, {
        kind: 'STATUS_REPORTED',
        occurredAt: this.clock(),
        source: 'APPLICATION',
        status: input.status,
      });
      await this.append(current, next);
      return next;
    });
  }

  public async attachTerminal(
    input: AttachAgentSessionTerminalInput,
  ): Promise<AgentSessionTerminalAttachment> {
    let runtimeState = this.ownedRuntimes.get(input.sessionId);
    const inFlightStart = this.starts.get(input.sessionId);
    if (runtimeState === undefined && inFlightStart !== undefined) {
      await inFlightStart;
      runtimeState = this.ownedRuntimes.get(input.sessionId);
    }

    if (runtimeState === undefined) {
      throw new AgentSessionRuntimeOwnershipError(input.sessionId);
    }
    await this.flush(input.sessionId);

    const handle = runtimeState.handle;
    if (
      handle === undefined ||
      !runtimeState.acceptingTerminalInput ||
      this.ownedRuntimes.get(input.sessionId) !== runtimeState
    ) {
      throw new AgentSessionRuntimeOwnershipError(input.sessionId);
    }

    runtimeState.observers.add(input.eventSink);
    let attached = true;
    const requireAttachedHandle = (operation: 'resize' | 'write'): PtyHandle => {
      if (
        !attached ||
        !runtimeState.acceptingTerminalInput ||
        runtimeState.handle !== handle ||
        this.ownedRuntimes.get(input.sessionId) !== runtimeState
      ) {
        throw new PtyRuntimeError(operation, 'NOT_RUNNING');
      }
      return handle;
    };

    return Object.freeze({
      detach: (): void => {
        if (!attached) {
          return;
        }
        attached = false;
        runtimeState.observers.delete(input.eventSink);
      },
      resize: async (size: PtyTerminalSize): Promise<void> => {
        await requireAttachedHandle('resize').resize(size);
      },
      write: async (terminalInput: string): Promise<void> => {
        await requireAttachedHandle('write').write(terminalInput);
      },
    });
  }

  public async findById(id: string): Promise<AgentSession | undefined> {
    await this.flush(id);
    return this.sessions.findById(id);
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    const matchingRuntimes = [...this.ownedRuntimes.keys()];
    for (const sessionId of matchingRuntimes) {
      const session = await this.sessions.findById(sessionId);
      if (session?.taskId === taskId) {
        await this.flush(sessionId);
      }
    }
    return this.sessions.listByTaskId(taskId);
  }

  public async findOwnedRuntimeByTaskId(taskId: string): Promise<AgentSession | undefined> {
    for (const sessionId of [...this.ownedRuntimes.keys()]) {
      const current = await this.sessions.findById(sessionId);
      if (current?.taskId !== taskId) {
        continue;
      }
      await this.flush(sessionId);
      if (this.ownedRuntimes.has(sessionId)) {
        return this.sessions.findById(sessionId);
      }
    }
    return undefined;
  }

  private async startOnce(input: StartAgentSessionInput): Promise<AgentSession> {
    if ((await this.tasks.findById(input.taskId)) === undefined) {
      throw new EntityNotFoundError('Task', input.taskId);
    }

    const existing = await this.sessions.findById(input.sessionId);
    if (existing !== undefined) {
      if (existing.taskId !== input.taskId || existing.agentId !== this.agentId) {
        throw new EntityAlreadyExistsError('AgentSession', input.sessionId);
      }
      if (this.ownedRuntimes.has(input.sessionId)) {
        await this.flush(input.sessionId);
        return this.requireSession(input.sessionId);
      }
      if (isTerminal(existing)) {
        return existing;
      }
      throw new AgentSessionRuntimeOwnershipError(input.sessionId);
    }

    const active = (await this.sessions.listActive()).find(
      (session) => session.taskId === input.taskId,
    );
    if (active !== undefined) {
      throw new AgentSessionActiveConflictError(input.taskId);
    }

    const starting = createAgentSession({
      agentId: this.agentId,
      createdAt: this.clock(),
      id: input.sessionId,
      taskId: input.taskId,
    });
    await this.sessions.insert(starting);

    let command;
    try {
      command = await this.adapter.buildLaunchCommand({
        environment: input.environment,
        workingDirectory: input.workingDirectory,
      });
    } catch (error) {
      await this.persistLaunchFailure(
        starting,
        error instanceof AgentAdapterError ? error.reason : 'RUNTIME_FAILURE',
      );
      throw error;
    }

    const bufferedEvents: PtyRuntimeEvent[] = [];
    let buffering = true;
    const runtimeState: OwnedSessionRuntime = {
      acceptingTerminalInput: true,
      failure: undefined,
      handle: undefined,
      observers: new Set(input.eventSink === undefined ? [] : [input.eventSink]),
      runtimeEvents: new Map(),
      stopAttempt: undefined,
      stopRequested: false,
      tail: Promise.resolve(),
    };
    const sink = (event: PtyRuntimeEvent): void => {
      if (isTerminalRuntimeEvent(event)) {
        runtimeState.acceptingTerminalInput = false;
      }
      for (const observer of [...runtimeState.observers]) {
        safelyPublish(observer, event);
      }
      if (event.kind === 'output') {
        return;
      }
      if (buffering) {
        bufferedEvents.push(event);
      } else {
        this.enqueueRuntimeEvent(input.sessionId, runtimeState, event);
      }
    };

    try {
      const handle = await this.runtime.open(
        {
          arguments: command.arguments,
          environment: command.environment,
          executablePath: command.executablePath,
          initialSize: input.initialSize,
          workingDirectory: command.workingDirectory,
        },
        sink,
      );
      runtimeState.handle = handle;
      this.ownedRuntimes.set(input.sessionId, runtimeState);
      buffering = false;
      for (const event of bufferedEvents) {
        this.enqueueRuntimeEvent(input.sessionId, runtimeState, event);
      }
      await this.flush(input.sessionId);
      return this.requireSession(input.sessionId);
    } catch (error) {
      buffering = false;
      if (runtimeState.handle !== undefined) {
        throw error;
      }
      const spawnFailure = bufferedEvents.find(
        (event): event is Extract<PtyRuntimeEvent, { kind: 'failed' }> =>
          event.kind === 'failed' && event.operation === 'spawn',
      );
      await this.persistLaunchFailure(
        await this.requireSession(input.sessionId),
        spawnFailure?.reason ?? 'RUNTIME_FAILURE',
        spawnFailure?.sequence,
      );
      throw error;
    }
  }

  private async persistLaunchFailure(
    current: AgentSession,
    code: string,
    runtimeSequence?: number,
  ): Promise<void> {
    if (current.status === AgentSessionStatus.FAILED) {
      return;
    }
    const failed = recordAgentSessionEvent(current, {
      code,
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: this.clock(),
      ...(runtimeSequence === undefined ? {} : { runtimeSequence }),
      stage: 'START',
    });
    try {
      await this.append(current, failed);
    } catch {
      throw new AgentSessionPersistenceError(current.id);
    }
  }

  private enqueueRuntimeEvent(
    sessionId: string,
    runtimeState: OwnedSessionRuntime,
    event: PtyRuntimeEvent,
  ): void {
    const serialized = JSON.stringify(event);
    const prior = runtimeState.runtimeEvents.get(event.sequence);
    if (prior !== undefined) {
      if (prior !== serialized && runtimeState.failure === undefined) {
        runtimeState.failure = new AgentSessionPersistenceError(sessionId);
      }
      return;
    }
    runtimeState.runtimeEvents.set(event.sequence, serialized);

    runtimeState.tail = runtimeState.tail
      .then(() => this.applyRuntimeEvent(sessionId, runtimeState, event))
      .catch(async () => {
        runtimeState.failure ??= new AgentSessionPersistenceError(sessionId);
        try {
          await runtimeState.handle?.terminate();
        } catch {
          // The durable mismatch remains the primary error; runtime cleanup is best effort here.
        }
      });
  }

  private async applyRuntimeEvent(
    sessionId: string,
    runtimeState: OwnedSessionRuntime,
    event: PtyRuntimeEvent,
  ): Promise<void> {
    if (event.kind === 'output') {
      return;
    }

    const current = await this.requireSession(sessionId);
    if (event.kind === 'started') {
      if (current.status !== AgentSessionStatus.STARTING) {
        return;
      }
      const working = recordAgentSessionEvent(current, {
        kind: 'STATUS_REPORTED',
        occurredAt: this.clock(),
        runtimeSequence: event.sequence,
        source: 'RUNTIME',
        status: AgentSessionStatus.WORKING,
      });
      await this.append(current, working);
      return;
    }

    if (event.kind === 'failed') {
      if (current.status === AgentSessionStatus.EXITED) {
        return;
      }
      const fatal = ['cleanup', 'runtime', 'spawn'].includes(event.operation);
      const failed = recordAgentSessionEvent(current, {
        code: event.reason,
        fatal,
        kind: 'RUNTIME_FAILED',
        occurredAt: this.clock(),
        runtimeSequence: event.sequence,
        stage: mapFailureStage(event.operation),
      });
      await this.append(current, failed);
      return;
    }

    if (current.status === AgentSessionStatus.EXITED) {
      return;
    }
    const exited = recordAgentSessionEvent(current, {
      exitCode: event.exitCode,
      kind: 'PROCESS_EXITED',
      occurredAt: this.clock(),
      reason: runtimeState.stopRequested ? 'STOPPED' : 'PROCESS_EXIT',
      runtimeSequence: event.sequence,
      ...(event.signal === undefined ? {} : { signal: event.signal }),
    });
    await this.append(current, exited);
    this.ownedRuntimes.delete(sessionId);
  }

  private async stopOnce(
    sessionId: string,
    runtimeState: OwnedSessionRuntime | undefined,
  ): Promise<AgentSession> {
    await this.flush(sessionId);
    const current = await this.requireSession(sessionId);
    if (current.status === AgentSessionStatus.EXITED) {
      return current;
    }
    if (current.status === AgentSessionStatus.FAILED && runtimeState?.handle === undefined) {
      return current;
    }
    if (runtimeState?.handle === undefined) {
      throw new AgentSessionRuntimeOwnershipError(sessionId);
    }

    if (current.status !== AgentSessionStatus.FAILED) {
      await this.runSerialized(runtimeState, async () => {
        const latest = await this.requireSession(sessionId);
        const requested = recordAgentSessionEvent(latest, {
          kind: 'STOP_REQUESTED',
          occurredAt: this.clock(),
        });
        if (requested !== latest) {
          await this.append(latest, requested);
        }
      });
    }
    runtimeState.stopRequested = true;

    try {
      await runtimeState.handle.terminate();
    } catch (error) {
      await runtimeState.tail;
      if (runtimeState.failure !== undefined) {
        throw runtimeState.failure;
      }
      const latest = await this.requireSession(sessionId);
      const lastEvent = latest.history.at(-1);
      if (lastEvent?.kind !== 'RUNTIME_FAILED' || lastEvent.stage !== 'TERMINATE') {
        const failed = recordAgentSessionEvent(latest, {
          code: 'RUNTIME_FAILURE',
          fatal: false,
          kind: 'RUNTIME_FAILED',
          occurredAt: this.clock(),
          stage: 'TERMINATE',
        });
        await this.append(latest, failed);
      }
      throw error;
    }

    await this.flush(sessionId);
    return this.requireSession(sessionId);
  }

  private async append(current: AgentSession, next: AgentSession): Promise<void> {
    await this.sessions.append(next, current.history.length);
  }

  private async flush(sessionId: string): Promise<void> {
    const runtimeState = this.ownedRuntimes.get(sessionId);
    if (runtimeState === undefined) {
      return;
    }
    while (true) {
      const observedTail = runtimeState.tail;
      await observedTail;
      if (observedTail === runtimeState.tail) {
        break;
      }
    }
    if (runtimeState.failure !== undefined) {
      throw runtimeState.failure;
    }
  }

  private async runSerialized<T>(
    runtimeState: OwnedSessionRuntime | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (runtimeState === undefined) {
      return operation();
    }
    const attempt = runtimeState.tail.then(() => {
      if (runtimeState.failure !== undefined) {
        throw runtimeState.failure;
      }
      return operation();
    });
    runtimeState.tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  private async requireSession(sessionId: string): Promise<AgentSession> {
    const session = await this.sessions.findById(sessionId);
    if (session === undefined) {
      throw new EntityNotFoundError('AgentSession', sessionId);
    }
    return session;
  }
}

function mapFailureStage(
  operation: Extract<PtyRuntimeEvent, { kind: 'failed' }>['operation'],
): AgentSessionFailureStage {
  switch (operation) {
    case 'spawn':
      return 'START';
    case 'runtime':
      return 'RUNTIME';
    case 'cleanup':
      return 'CLEANUP';
    case 'write':
      return 'WRITE';
    case 'resize':
      return 'RESIZE';
    case 'terminate':
      return 'TERMINATE';
  }
}

function isTerminal(session: AgentSession): boolean {
  return (
    session.status === AgentSessionStatus.EXITED || session.status === AgentSessionStatus.FAILED
  );
}

function safelyPublish(sink: PtyRuntimeEventSink | undefined, event: PtyRuntimeEvent): void {
  try {
    sink?.(event);
  } catch {
    // Observers cannot break durable session tracking or native runtime cleanup.
  }
}

function isTerminalRuntimeEvent(event: PtyRuntimeEvent): boolean {
  return (
    event.kind === 'exited' ||
    (event.kind === 'failed' && ['cleanup', 'runtime', 'spawn'].includes(event.operation))
  );
}
