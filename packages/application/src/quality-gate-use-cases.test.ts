import { describe, expect, it, vi } from 'vitest';

import {
  createProject,
  createQualityGate,
  createTask,
  QualityGateKind,
  QualityGateRunStatus,
  type QualityGateRun,
  type Task,
} from '@agentterm/domain';

import {
  EntityNotFoundError,
  listQualityGateRuns,
  QualityGatePersistenceError,
  runQualityGate,
  type GitTaskWorktreeLifecycle,
  type LocalProject,
  type LocalProjectLocator,
  type QualityGateCatalog,
  type QualityGateProcessRequest,
  type QualityGateProcessResult,
  type QualityGateProcessRunner,
  type QualityGateRunRepository,
  type TaskRepository,
  type TaskWorktree,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from './index';

const task = createTask({
  id: 'task-1',
  projectId: 'project-1',
  title: 'Ki\u1ec3m tra ch\u1ea5t l\u01b0\u1ee3ng',
});
const project: LocalProject = {
  ...createProject({ id: task.projectId, name: 'AgentTerm' }),
  rootPath: 'D:\\Repositories\\AgentTerm',
};
const worktree: TaskWorktree = {
  baseCommitId: 'a'.repeat(40),
  baseRefName: 'refs/heads/main',
  branchName: 'agentterm/task/abc',
  pathIdentity: 'worktree-identity',
  repositoryRootPath: project.rootPath,
  taskId: task.id,
  worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
};
const record: TaskWorktreeRecord = { ...worktree, lifecycleState: 'PRESENT' };
const gate = createQualityGate({
  command: {
    arguments: ['D:\\tools\\pnpm.cjs', 'lint'],
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
  },
  id: 'lint',
  kind: QualityGateKind.LINT,
  timeoutMs: 60_000,
});

class FakeTasks implements TaskRepository {
  public readonly update = vi.fn(async () => undefined);
  public constructor(private readonly value: Task | null = task) {}
  public async findById(id: string): Promise<Task | undefined> {
    return this.value?.id === id ? this.value : undefined;
  }
  public async insert(): Promise<never> {
    throw new Error('insert is not used');
  }
}

class FakeProjects implements LocalProjectLocator {
  public async findLocalById(id: string): Promise<LocalProject | undefined> {
    return id === project.id ? project : undefined;
  }
}

class FakeWorktrees implements TaskWorktreeRepository {
  public constructor(private readonly value: TaskWorktreeRecord | undefined = record) {}
  public async findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined> {
    return taskId === task.id ? this.value : undefined;
  }
  public async insertReservation(): Promise<never> {
    throw new Error('Gate execution must not provision a Worktree');
  }
  public async transitionState(): Promise<never> {
    throw new Error('Gate execution must not mutate Worktree metadata');
  }
}

class FakeGit implements GitTaskWorktreeLifecycle {
  public inspection: Awaited<ReturnType<GitTaskWorktreeLifecycle['inspect']>> = {
    headCommitId: 'b'.repeat(40),
    kind: 'present',
    status: {
      conflictedPaths: [],
      ignoredPaths: [],
      isDirty: true,
      stagedPaths: [],
      unstagedPaths: ['src/user-change.ts'],
      untrackedPaths: [],
    },
    worktree,
  };
  public readonly ensure = vi.fn(async () => {
    throw new Error('Gate execution must not ensure a Worktree');
  });
  public readonly cleanup = vi.fn(async () => {
    throw new Error('Gate execution must not clean a Worktree');
  });
  public async inspect(): Promise<typeof this.inspection> {
    return this.inspection;
  }
}

class FakeGateCatalog implements QualityGateCatalog {
  public constructor(private readonly value = gate) {}
  public async findById(id: string) {
    return id === this.value.id ? this.value : undefined;
  }
}

class FakeProcessRunner implements QualityGateProcessRunner {
  public readonly requests: QualityGateProcessRequest[] = [];
  public constructor(
    public result: QualityGateProcessResult = {
      exitCode: 0,
      kind: 'exited',
      output: 'lint pass \u2713',
      truncated: false,
    },
    private readonly trace?: string[],
  ) {}
  public async run(request: QualityGateProcessRequest): Promise<QualityGateProcessResult> {
    this.trace?.push('process');
    this.requests.push(request);
    return this.result;
  }
}

class FakeRuns implements QualityGateRunRepository {
  public readonly values: QualityGateRun[] = [];
  public insertFailure: Error | undefined;
  public finalizeFailure: Error | undefined;
  public constructor(private readonly trace?: string[]) {}
  public async findById(id: string): Promise<QualityGateRun | undefined> {
    return this.values.find((run) => run.id === id);
  }
  public async insert(run: QualityGateRun): Promise<void> {
    this.trace?.push('insert');
    if (this.insertFailure !== undefined) throw this.insertFailure;
    this.values.push(run);
  }
  public async finalize(run: QualityGateRun): Promise<void> {
    this.trace?.push('finalize');
    if (this.finalizeFailure !== undefined) throw this.finalizeFailure;
    const index = this.values.findIndex((value) => value.id === run.id);
    if (index < 0) throw new Error('missing run');
    this.values[index] = run;
  }
  public async listByTaskId(taskId: string): Promise<readonly QualityGateRun[]> {
    return this.values.filter((run) => run.taskId === taskId);
  }
}

function dependencies(
  options: {
    readonly git?: FakeGit;
    readonly processRunner?: FakeProcessRunner;
    readonly runs?: FakeRuns;
    readonly tasks?: FakeTasks;
  } = {},
) {
  return {
    clock: sequenceClock(1_000, 1_075),
    gates: new FakeGateCatalog(),
    git: options.git ?? new FakeGit(),
    localProjects: new FakeProjects(),
    maxOutputBytes: 262_144,
    processRunner: options.processRunner ?? new FakeProcessRunner(),
    runs: options.runs ?? new FakeRuns(),
    tasks: options.tasks ?? new FakeTasks(),
    worktrees: new FakeWorktrees(),
  };
}

describe('runQualityGate', () => {
  it('persists RUNNING before a structured process in the verified dirty Task Worktree, then records PASS', async () => {
    const trace: string[] = [];
    const runs = new FakeRuns(trace);
    const processRunner = new FakeProcessRunner(undefined, trace);
    const tasks = new FakeTasks();

    const completed = await runQualityGate(
      {
        environment: {
          PATH: 'C:\\tools',
          SAFE_VALUE: 'visible',
          SHORT_TOKEN: 'abc',
          SERVICE_TOKEN: 'super-secret-token',
        },
        gateId: gate.id,
        runId: 'run-1',
        taskId: task.id,
      },
      dependencies({ processRunner, runs, tasks }),
    );

    expect(trace).toEqual(['insert', 'process', 'finalize']);
    expect(processRunner.requests).toEqual([
      {
        arguments: gate.command.arguments,
        environment: {
          PATH: 'C:\\tools',
          SAFE_VALUE: 'visible',
          SHORT_TOKEN: 'abc',
          SERVICE_TOKEN: 'super-secret-token',
        },
        executablePath: gate.command.executablePath,
        maxOutputBytes: 262_144,
        redactValues: ['abc', 'super-secret-token'],
        timeoutMs: gate.timeoutMs,
        workingDirectory: worktree.worktreePath,
      },
    ]);
    expect(completed).toMatchObject({
      output: { text: 'lint pass \u2713', truncated: false },
      status: QualityGateRunStatus.PASSED,
      worktree: {
        pathIdentity: worktree.pathIdentity,
        worktreePath: worktree.worktreePath,
      },
    });
    expect(runs.values.map(({ status }) => status)).toEqual(['PASSED']);
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      { exitCode: 2, kind: 'exited', output: 'tests failed', truncated: false } as const,
      QualityGateRunStatus.FAILED,
    ],
    [
      {
        kind: 'timed-out',
        output: 'still running',
        terminationFailed: false,
        truncated: false,
      } as const,
      QualityGateRunStatus.TIMED_OUT,
    ],
    [
      {
        kind: 'launch-error',
        output: '',
        reason: 'EXECUTABLE_NOT_FOUND',
        truncated: false,
      } as const,
      QualityGateRunStatus.LAUNCH_FAILED,
    ],
    [
      {
        kind: 'infrastructure-error',
        output: 'partial output',
        reason: 'PROCESS_PROTOCOL_ERROR',
        truncated: false,
      } as const,
      QualityGateRunStatus.INFRASTRUCTURE_FAILED,
    ],
  ])('maps process evidence to %s without mutating Task phase', async (result, expected) => {
    const runner = new FakeProcessRunner(result);
    const tasks = new FakeTasks();
    const completed = await runQualityGate(
      { environment: {}, gateId: gate.id, runId: `run-${expected}`, taskId: task.id },
      dependencies({ processRunner: runner, tasks }),
    );

    expect(completed.status).toBe(expected);
    expect(tasks.update).not.toHaveBeenCalled();
  });

  it('blocks missing, stale, or non-PRESENT Worktrees before inserting evidence or starting a process', async () => {
    const git = new FakeGit();
    git.inspection = { kind: 'missing', worktree };
    const runner = new FakeProcessRunner();
    const runs = new FakeRuns();

    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-missing', taskId: task.id },
        dependencies({ git, processRunner: runner, runs }),
      ),
    ).rejects.toMatchObject({ reason: 'WORKTREE_NOT_READY', taskId: task.id });
    expect(runner.requests).toHaveLength(0);
    expect(runs.values).toHaveLength(0);
  });

  it('does not start a process when the Task, gate, or initial persistence is missing', async () => {
    const runner = new FakeProcessRunner();
    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-no-task', taskId: task.id },
        dependencies({ processRunner: runner, tasks: new FakeTasks(null) }),
      ),
    ).rejects.toBeInstanceOf(EntityNotFoundError);

    const runs = new FakeRuns();
    runs.insertFailure = new Error('database unavailable');
    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-db-fail', taskId: task.id },
        dependencies({ processRunner: runner, runs }),
      ),
    ).rejects.toThrow('database unavailable');
    expect(runner.requests).toHaveLength(0);
  });

  it('rejects mismatched catalog identity and credential-like command arguments before persistence', async () => {
    const runner = new FakeProcessRunner();
    const runs = new FakeRuns();
    const mismatchedGate = createQualityGate({ ...gate, id: 'different-gate' });

    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-mismatch', taskId: task.id },
        {
          ...dependencies({ processRunner: runner, runs }),
          gates: { findById: async () => mismatchedGate },
        },
      ),
    ).rejects.toMatchObject({ reason: 'GATE_NOT_FOUND' });

    const unsafeGate = createQualityGate({
      ...gate,
      command: { ...gate.command, arguments: ['test', '--api-key=must-not-persist'] },
    });
    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-unsafe', taskId: task.id },
        {
          ...dependencies({ processRunner: runner, runs }),
          gates: new FakeGateCatalog(unsafeGate),
        },
      ),
    ).rejects.toMatchObject({ reason: 'UNSAFE_COMMAND_METADATA' });

    const authorizationHeaderGate = createQualityGate({
      ...gate,
      command: {
        ...gate.command,
        arguments: ['test', '--header', 'Authorization: Bearer must-not-persist'],
      },
    });
    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-unsafe-header', taskId: task.id },
        {
          ...dependencies({ processRunner: runner, runs }),
          gates: new FakeGateCatalog(authorizationHeaderGate),
        },
      ),
    ).rejects.toMatchObject({ reason: 'UNSAFE_COMMAND_METADATA' });
    expect(runs.values).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);
  });

  it('rejects an accessor-backed environment before persistence without exposing its error', async () => {
    const runner = new FakeProcessRunner();
    const runs = new FakeRuns();
    const secret = 'environment-getter-secret';
    const environment = Object.defineProperty({}, 'SERVICE_TOKEN', {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    }) as Readonly<Record<string, string>>;

    let caught: unknown;
    try {
      await runQualityGate(
        { environment, gateId: gate.id, runId: 'run-invalid-environment', taskId: task.id },
        dependencies({ processRunner: runner, runs }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ reason: 'INVALID_ENVIRONMENT' });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(runs.values).toHaveLength(0);
    expect(runner.requests).toHaveLength(0);
  });

  it('surfaces completed process evidence when final persistence fails without rerunning it', async () => {
    const runner = new FakeProcessRunner();
    const runs = new FakeRuns();
    runs.finalizeFailure = new Error('disk full');

    let caught: unknown;
    try {
      await runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-finalize-fail', taskId: task.id },
        dependencies({ processRunner: runner, runs }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(QualityGatePersistenceError);
    expect(caught).toMatchObject({
      observedRun: { id: 'run-finalize-fail', status: 'PASSED' },
      persistedStatus: 'RUNNING',
    });
    expect(runs.values).toMatchObject([{ id: 'run-finalize-fail', status: 'RUNNING' }]);
    expect(runner.requests).toHaveLength(1);
  });

  it('fails closed when timeout tree termination cannot be confirmed', async () => {
    const runner = new FakeProcessRunner({
      kind: 'timed-out',
      output: 'partial',
      terminationFailed: true,
      truncated: false,
    });
    const completed = await runQualityGate(
      { environment: {}, gateId: gate.id, runId: 'run-uncertain', taskId: task.id },
      dependencies({ processRunner: runner }),
    );
    expect(completed).toMatchObject({
      failureCategory: 'INFRASTRUCTURE',
      status: 'INFRASTRUCTURE_FAILED',
    });
  });

  it('redacts and bounds output again before persistence even when a runner violates its contract', async () => {
    const runner = new FakeProcessRunner({
      exitCode: 0,
      kind: 'exited',
      output: `before super-secret-token ${'x'.repeat(100)}`,
      truncated: false,
    });
    const completed = await runQualityGate(
      {
        environment: { SERVICE_TOKEN: 'super-secret-token' },
        gateId: gate.id,
        runId: 'run-defense-in-depth',
        taskId: task.id,
      },
      { ...dependencies({ processRunner: runner }), maxOutputBytes: 32 },
    );

    expect(completed.output).toMatchObject({ truncated: true });
    expect(completed.output?.text).not.toContain('super-secret-token');
    expect(completed.output?.text.length).toBeLessThanOrEqual(32);
  });

  it('rejects an output limit larger than the persistence contract before starting a process', async () => {
    const runner = new FakeProcessRunner();
    await expect(
      runQualityGate(
        { environment: {}, gateId: gate.id, runId: 'run-too-large', taskId: task.id },
        { ...dependencies({ processRunner: runner }), maxOutputBytes: 262_145 },
      ),
    ).rejects.toThrow(TypeError);
    expect(runner.requests).toHaveLength(0);
  });

  it('uses a nonnegative duration when the wall clock moves backwards during execution', async () => {
    const completed = await runQualityGate(
      { environment: {}, gateId: gate.id, runId: 'run-clock-skew', taskId: task.id },
      { ...dependencies(), clock: sequenceClock(2_000, 1_000) },
    );
    expect(completed).toMatchObject({ durationMs: 0, finishedAt: 2_000, startedAt: 2_000 });
  });
});

describe('listQualityGateRuns', () => {
  it('returns every immutable run for an existing Task and rejects a missing Task', async () => {
    const runs = new FakeRuns();
    const deps = dependencies({ runs });
    await runQualityGate(
      { environment: {}, gateId: gate.id, runId: 'run-history-1', taskId: task.id },
      deps,
    );
    deps.clock = sequenceClock(2_000, 2_025);
    await runQualityGate(
      { environment: {}, gateId: gate.id, runId: 'run-history-2', taskId: task.id },
      deps,
    );

    await expect(listQualityGateRuns(task.id, deps.tasks, runs)).resolves.toMatchObject([
      { id: 'run-history-1' },
      { id: 'run-history-2' },
    ]);
    await expect(listQualityGateRuns('missing', new FakeTasks(null), runs)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });
});

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
