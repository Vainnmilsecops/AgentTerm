import { describe, expect, it } from 'vitest';

import {
  AgentSessionStatus,
  ExecutionArtifactKind,
  QualityGateKind,
  QualityGateRunStatus,
  TaskPhase,
  TaskReviewGateAssociation,
  TaskReviewStatus,
  completeQualityGateRun,
  createAgentSession,
  createExecutionArtifact,
  createQualityGate,
  createTask,
  decideTaskReview,
  recordAgentSessionEvent,
  startQualityGateRun,
  transitionTask,
  type AgentSession,
  type ExecutionArtifact,
  type QualityGateRun,
  type Task,
  type TaskPhase as TaskPhaseValue,
  type TaskReview,
  type TaskReviewCodeState,
} from '@agentterm/domain';

import {
  approveTaskReview,
  listTaskReviews,
  requestTaskChanges,
  requestTaskReview,
  TaskReviewReadinessError,
  type AgentSessionRepository,
  type ExecutionArtifactRepository,
  type GitTaskWorktreeLifecycle,
  type LocalProject,
  type LocalProjectLocator,
  type QualityGateRunRepository,
  type TaskRepository,
  type TaskReviewCodeInspector,
  type TaskReviewRepository,
  type TaskReviewQualityGateEvidenceSource,
  type TaskWorktree,
  type TaskWorktreeRecord,
  type TaskWorktreeRepository,
} from './index';

const project: LocalProject = Object.freeze({
  id: 'project-1',
  name: 'AgentTerm',
  rootPath: 'D:\\repositories\\agentterm',
});
const worktree: TaskWorktree = Object.freeze({
  baseCommitId: 'a'.repeat(40),
  baseRefName: 'refs/heads/main',
  branchName: 'agentterm/task/review-flow',
  pathIdentity: 'win32:d:\\worktrees\\review-flow',
  repositoryRootPath: project.rootPath,
  taskId: 'task-1',
  worktreePath: 'D:\\worktrees\\review-flow',
});
const presentRecord: TaskWorktreeRecord = Object.freeze({
  ...worktree,
  lifecycleState: 'PRESENT',
});
const codeState: TaskReviewCodeState = Object.freeze({
  baseCommitId: worktree.baseCommitId,
  branchName: worktree.branchName,
  changes: Object.freeze({
    committed: Object.freeze(['packages/domain/src/task.ts']),
    conflicted: Object.freeze([]),
    staged: Object.freeze([]),
    total: 2,
    truncated: false,
    unstaged: Object.freeze(['docs/CURRENT_STATE.md']),
    untracked: Object.freeze([]),
  }),
  fingerprint: 'f'.repeat(64),
  headCommitId: 'b'.repeat(40),
  schemaVersion: 1,
  worktreePathIdentity: worktree.pathIdentity,
});

class MemoryTasks implements TaskRepository {
  private readonly values = new Map<string, Task>();

  public constructor(tasks: readonly Task[]) {
    for (const task of tasks) this.values.set(task.id, task);
  }

  public async findById(id: string): Promise<Task | undefined> {
    return this.values.get(id);
  }

  public async insert(task: Task): Promise<void> {
    this.values.set(task.id, task);
  }

  public async update(task: Task, expectedPhase: Task['phase']): Promise<void> {
    if (this.values.get(task.id)?.phase !== expectedPhase) throw new Error('missing or stale Task');
    this.values.set(task.id, task);
  }

  public replace(task: Task): void {
    this.values.set(task.id, task);
  }
}

class MemoryReviews implements TaskReviewRepository {
  private readonly values: TaskReview[] = [];
  public lastBeginSessionRevisions:
    readonly { readonly historySequence: number; readonly id: string }[] | undefined;

  public constructor(private readonly tasks: MemoryTasks) {}

  public async findById(id: string): Promise<TaskReview | undefined> {
    return this.values.find((review) => review.id === id);
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskReview[]> {
    return this.values.filter((review) => review.taskId === taskId);
  }

  public async listRecentByTaskId(taskId: string, limit: number): Promise<readonly TaskReview[]> {
    return this.values.filter((review) => review.taskId === taskId).slice(-limit);
  }

  public async begin(
    review: TaskReview,
    expectedTaskPhase: 'REVIEW' | 'RUNNING',
    nextTask: Task,
    expectedSessionRevisions: readonly {
      readonly historySequence: number;
      readonly id: string;
    }[],
  ): Promise<void> {
    const storedTask = await this.tasks.findById(review.taskId);
    if (
      storedTask?.phase !== expectedTaskPhase ||
      nextTask.id !== review.taskId ||
      nextTask.phase !== TaskPhase.REVIEW ||
      (expectedTaskPhase === TaskPhase.REVIEW && this.values.length !== 0) ||
      review.status !== TaskReviewStatus.PENDING ||
      this.values.some((value) => value.id === review.id || value.status === 'PENDING')
    ) {
      throw new Error('atomic review admission rejected');
    }
    this.lastBeginSessionRevisions = expectedSessionRevisions;
    this.values.push(review);
    this.tasks.replace(nextTask);
  }

  public async decide(
    review: TaskReview,
    expectedStatus: 'PENDING',
    expectedTaskPhase: 'REVIEW',
    nextTask: Task,
  ): Promise<void> {
    const index = this.values.findIndex((value) => value.id === review.id);
    const storedReview = this.values[index];
    const storedTask = await this.tasks.findById(review.taskId);
    if (
      storedReview?.status !== expectedStatus ||
      storedTask?.phase !== expectedTaskPhase ||
      nextTask.id !== review.taskId ||
      (review.status === TaskReviewStatus.APPROVED && nextTask.phase !== TaskPhase.DONE) ||
      (review.status === TaskReviewStatus.CHANGES_REQUESTED && nextTask.phase !== TaskPhase.RUNNING)
    ) {
      throw new Error('atomic review decision rejected');
    }
    this.values[index] = review;
    this.tasks.replace(nextTask);
  }
}

class MemorySessions implements AgentSessionRepository {
  public constructor(private readonly values: readonly AgentSession[]) {}
  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.values.find((session) => session.id === id);
  }
  public async insert(): Promise<never> {
    throw new Error('review flow must not create Agent Sessions');
  }
  public async append(): Promise<never> {
    throw new Error('review flow must not mutate Agent Session history');
  }
  public async updateOwnership(): Promise<never> {
    throw new Error('review flow must not update Agent Session ownership');
  }
  public async listActive(): Promise<readonly AgentSession[]> {
    return this.values.filter((session) => !isTerminal(session));
  }
  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return this.values.filter((session) => session.taskId === taskId);
  }
}

class MemoryArtifacts implements ExecutionArtifactRepository {
  public listAllCalls = 0;
  public readonly reviewEvidenceLimits: number[] = [];
  public constructor(private readonly values: readonly ExecutionArtifact[]) {}
  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    return this.values.find((artifact) => artifact.id === id);
  }
  public async findLatestByTaskIdAndKind(
    taskId: string,
    kind: ExecutionArtifact['kind'],
  ): Promise<ExecutionArtifact | undefined> {
    const filtered = this.values.filter(
      (artifact) => artifact.taskId === taskId && artifact.kind === kind,
    );
    if (filtered.length === 0) return undefined;
    return filtered.reduce((latest, candidate) =>
      candidate.createdAt > latest.createdAt ? candidate : latest,
    );
  }
  public async insert(): Promise<never> {
    throw new Error('review flow must not create Execution Artifacts');
  }
  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    this.listAllCalls += 1;
    return this.values.filter((artifact) => artifact.taskId === taskId);
  }
  public async listRecentByTaskId(taskId: string, limit: number) {
    return this.values.filter((artifact) => artifact.taskId === taskId).slice(-limit);
  }
  public async readReviewEvidenceByTaskId(taskId: string, limit: number) {
    this.reviewEvidenceLimits.push(limit);
    const values = this.values.filter((artifact) => artifact.taskId === taskId);
    return {
      evidence:
        values.length > limit
          ? []
          : values.map(({ createdAt, id, kind, phase, sessionId }) => ({
              createdAt,
              id,
              kind,
              phase,
              sessionId,
            })),
      totalCount: values.length,
    };
  }
}

class MemoryGateRuns implements QualityGateRunRepository {
  public listAllCalls = 0;
  public readonly reviewEvidenceLimits: number[] = [];
  public constructor(private readonly values: readonly QualityGateRun[]) {}
  public async findById(id: string): Promise<QualityGateRun | undefined> {
    return this.values.find((run) => run.id === id);
  }
  public async insert(): Promise<never> {
    throw new Error('review flow must not create Quality Gate Runs');
  }
  public async finalize(): Promise<never> {
    throw new Error('review flow must not finalize Quality Gate Runs');
  }
  public async listByTaskId(taskId: string): Promise<readonly QualityGateRun[]> {
    this.listAllCalls += 1;
    return this.values.filter((run) => run.taskId === taskId);
  }
  public async listRecentByTaskId(taskId: string, limit: number) {
    return this.values.filter((run) => run.taskId === taskId).slice(-limit);
  }
  public async readReviewEvidenceByTaskId(taskId: string, limit: number) {
    this.reviewEvidenceLimits.push(limit);
    const values = this.values.filter((run) => run.taskId === taskId);
    return {
      evidence:
        values.length > limit
          ? []
          : values.map(
              ({ finishedAt, gate, id, startedAt, status, worktree }) =>
                ({
                  baseCommitId: worktree.baseCommitId,
                  branchName: worktree.branchName,
                  finishedAt,
                  gateId: gate.id,
                  headCommitIdAtStart: worktree.headCommitIdAtStart,
                  id,
                  kind: gate.kind,
                  observedStatus: status,
                  startedAt,
                  worktreePathIdentity: worktree.pathIdentity,
                }) satisfies TaskReviewQualityGateEvidenceSource,
            ),
      hasRunning: values.some(({ status }) => status === QualityGateRunStatus.RUNNING),
      totalCount: values.length,
    };
  }
}

class MemoryWorktrees implements TaskWorktreeRepository {
  public constructor(public record: TaskWorktreeRecord | undefined = presentRecord) {}
  public async findByTaskId(taskId: string): Promise<TaskWorktreeRecord | undefined> {
    return this.record?.taskId === taskId ? this.record : undefined;
  }
  public async insertReservation(): Promise<never> {
    throw new Error('review flow must not provision a Worktree');
  }
  public async transitionState(): Promise<never> {
    throw new Error('review flow must not mutate Worktree metadata');
  }
}

class FakeGit implements GitTaskWorktreeLifecycle {
  public inspection: Awaited<ReturnType<GitTaskWorktreeLifecycle['inspect']>> = {
    headCommitId: codeState.headCommitId,
    kind: 'present',
    status: {
      conflictedPaths: [],
      ignoredPaths: [],
      isDirty: true,
      stagedPaths: [],
      unstagedPaths: ['docs/CURRENT_STATE.md'],
      untrackedPaths: [],
    },
    worktree,
  };
  public async inspect(): Promise<typeof this.inspection> {
    return this.inspection;
  }
  public async ensure(): Promise<never> {
    throw new Error('review flow must not ensure a Worktree');
  }
  public async cleanup(): Promise<never> {
    throw new Error('review flow must not clean a Worktree');
  }
}

class FakeCodeInspector implements TaskReviewCodeInspector {
  public value = codeState;
  public calls = 0;
  public async inspect(actualWorktree: TaskWorktree): Promise<TaskReviewCodeState> {
    this.calls += 1;
    expect(actualWorktree).toEqual(worktree);
    return this.value;
  }
}

class FakeProjects implements LocalProjectLocator {
  public async findLocalById(id: string): Promise<LocalProject | undefined> {
    return id === project.id ? project : undefined;
  }
}

function taskAt(phase: TaskPhaseValue, id = worktree.taskId): Task {
  let task = createTask({ id, projectId: project.id, title: 'Implement Review Flow' });
  for (const next of [TaskPhase.PLANNING, TaskPhase.RUNNING, TaskPhase.REVIEW, TaskPhase.DONE]) {
    if (task.phase === phase) return task;
    task = transitionTask(task, next);
  }
  return task;
}

const plan = createExecutionArtifact({
  content: '# Plan\n\nInspect and implement Review Flow.',
  createdAt: 10,
  id: 'artifact-plan',
  kind: ExecutionArtifactKind.PLAN,
  taskId: worktree.taskId,
});
const summary = createExecutionArtifact({
  content: '# Execution Summary\n\nReview Flow implementation is ready for user review.',
  createdAt: 20,
  id: 'artifact-summary',
  kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
  sessionId: 'session-exited',
  taskId: worktree.taskId,
});
const gate = createQualityGate({
  command: { executablePath: 'C:\\tools\\pnpm.exe', arguments: ['test'] },
  id: 'test',
  kind: QualityGateKind.TEST,
  timeoutMs: 60_000,
});
const passedGate = completeQualityGateRun(
  startQualityGateRun({
    gate,
    id: 'gate-run-passed',
    startedAt: 30,
    taskId: worktree.taskId,
    worktree: {
      baseCommitId: codeState.baseCommitId,
      branchName: codeState.branchName,
      headCommitIdAtStart: codeState.headCommitId,
      pathIdentity: codeState.worktreePathIdentity,
      worktreePath: worktree.worktreePath,
    },
  }),
  {
    exitCode: 0,
    finishedAt: 40,
    kind: 'exited',
    output: { reference: 'gate-output:passed', text: 'passed', truncated: false },
  },
);

function exitedSession(): AgentSession {
  return recordAgentSessionEvent(
    createAgentSession({
      agentId: 'codex',
      createdAt: 1,
      id: 'session-exited',
      taskId: worktree.taskId,
    }),
    {
      exitCode: 0,
      kind: 'PROCESS_EXITED',
      occurredAt: 2,
      reason: 'PROCESS_EXIT',
      runtimeSequence: 1,
    },
  );
}

function activeSession(): AgentSession {
  return recordAgentSessionEvent(
    createAgentSession({
      agentId: 'codex',
      createdAt: 1,
      id: 'session-working',
      taskId: worktree.taskId,
    }),
    {
      kind: 'STATUS_REPORTED',
      occurredAt: 2,
      runtimeSequence: 1,
      source: 'RUNTIME',
      status: AgentSessionStatus.WORKING,
    },
  );
}

function failedRuntimeSession(processExited: boolean): AgentSession {
  let session = recordAgentSessionEvent(
    createAgentSession({
      agentId: 'codex',
      createdAt: 1,
      id: 'session-runtime-failed',
      taskId: worktree.taskId,
    }),
    {
      kind: 'STATUS_REPORTED',
      occurredAt: 2,
      runtimeSequence: 1,
      source: 'RUNTIME',
      status: AgentSessionStatus.WORKING,
    },
  );
  session = recordAgentSessionEvent(session, {
    code: 'RUNTIME_FAILURE',
    fatal: true,
    kind: 'RUNTIME_FAILED',
    occurredAt: 3,
    runtimeSequence: 2,
    stage: 'RUNTIME',
  });
  return processExited
    ? recordAgentSessionEvent(session, {
        exitCode: 1,
        kind: 'PROCESS_EXITED',
        occurredAt: 4,
        reason: 'PROCESS_EXIT',
        runtimeSequence: 3,
      })
    : session;
}

function runtimeOwnershipLostSession(): AgentSession {
  return recordAgentSessionEvent(
    createAgentSession({
      agentId: 'codex',
      createdAt: 1,
      id: 'session-runtime-ownership-lost',
      taskId: worktree.taskId,
    }),
    {
      code: 'RUNTIME_OWNERSHIP_LOST',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: 2,
      runtimeSequence: 1,
      stage: 'RUNTIME',
    },
  );
}

function fixture(
  options: {
    readonly artifacts?: readonly ExecutionArtifact[];
    readonly phase?: TaskPhaseValue;
    readonly qualityGateRuns?: readonly QualityGateRun[];
    readonly sessions?: readonly AgentSession[];
  } = {},
) {
  const tasks = new MemoryTasks([taskAt(options.phase ?? TaskPhase.RUNNING)]);
  const reviews = new MemoryReviews(tasks);
  const codeInspector = new FakeCodeInspector();
  const git = new FakeGit();
  const artifacts = new MemoryArtifacts(options.artifacts ?? [plan, summary]);
  const qualityGateRuns = new MemoryGateRuns(options.qualityGateRuns ?? [passedGate]);
  let now = 50;
  return {
    dependencies: {
      artifacts,
      clock: () => now++,
      codeInspector,
      git,
      localProjects: new FakeProjects(),
      qualityGateRuns,
      reviews,
      sessions: new MemorySessions(options.sessions ?? [exitedSession()]),
      tasks,
      worktrees: new MemoryWorktrees(),
    },
    artifacts,
    codeInspector,
    git,
    qualityGateRuns,
    reviews,
    tasks,
  };
}

describe('requestTaskReview', () => {
  it('atomically moves RUNNING to REVIEW with exact code, Artifact, and gate evidence', async () => {
    const current = fixture();

    const result = await requestTaskReview(
      { reviewId: 'review-1', taskId: worktree.taskId },
      current.dependencies,
    );

    expect(result.task.phase).toBe(TaskPhase.REVIEW);
    expect(result.review).toMatchObject({
      artifacts: [
        { id: plan.id, kind: plan.kind, phase: plan.phase },
        { id: summary.id, kind: summary.kind, phase: summary.phase, sessionId: summary.sessionId },
      ],
      codeState,
      id: 'review-1',
      qualityGates: [
        {
          association: TaskReviewGateAssociation.HEAD_MATCH_ONLY,
          id: passedGate.id,
          observedStatus: QualityGateRunStatus.PASSED,
        },
      ],
      status: TaskReviewStatus.PENDING,
      taskId: worktree.taskId,
    });
    expect(result.context).toEqual({
      artifacts: result.review.artifacts,
      qualityGates: result.review.qualityGates,
    });
    expect(current.artifacts.listAllCalls).toBe(0);
    expect(current.qualityGateRuns.listAllCalls).toBe(0);
    expect(current.artifacts.reviewEvidenceLimits).toEqual([1_000]);
    expect(current.qualityGateRuns.reviewEvidenceLimits).toEqual([1_000]);
    expect(current.reviews.lastBeginSessionRevisions).toEqual([
      { historySequence: exitedSession().history.length, id: exitedSession().id },
    ]);
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: 'REVIEW',
    });
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toEqual([result.review]);
  });

  it('captures immutable evidence baselines before inspecting code state', async () => {
    const current = fixture();
    const order: string[] = [];
    const artifacts = current.dependencies.artifacts;
    const qualityGateRuns = current.dependencies.qualityGateRuns;
    const originalArtifactList = artifacts.readReviewEvidenceByTaskId.bind(artifacts);
    const originalGateList = qualityGateRuns.readReviewEvidenceByTaskId.bind(qualityGateRuns);
    const originalInspect = current.codeInspector.inspect.bind(current.codeInspector);
    artifacts.readReviewEvidenceByTaskId = async (taskId, limit) => {
      order.push('artifacts');
      return originalArtifactList(taskId, limit);
    };
    qualityGateRuns.readReviewEvidenceByTaskId = async (taskId, limit) => {
      order.push('gates');
      return originalGateList(taskId, limit);
    };
    current.codeInspector.inspect = async (taskWorktree) => {
      order.push('code');
      return originalInspect(taskWorktree);
    };

    await requestTaskReview(
      { reviewId: 'review-evidence-before-code', taskId: worktree.taskId },
      current.dependencies,
    );

    expect(order.indexOf('artifacts')).toBeLessThan(order.indexOf('code'));
    expect(order.indexOf('gates')).toBeLessThan(order.indexOf('code'));
  });

  it('does not treat a passing Quality Gate as review approval or Task completion', async () => {
    const current = fixture();

    const result = await requestTaskReview(
      { reviewId: 'review-pass-is-evidence', taskId: worktree.taskId },
      current.dependencies,
    );

    expect(result.review).toMatchObject({
      qualityGates: [{ observedStatus: 'PASSED' }],
      status: 'PENDING',
    });
    expect(result.task.phase).toBe(TaskPhase.REVIEW);
    expect(result.task.phase).not.toBe(TaskPhase.DONE);
  });

  it.each([
    [
      'Artifact',
      {
        artifacts: Array.from({ length: 1_001 }, (_, index) =>
          createExecutionArtifact({
            content: '# Plan\n\nBounded review evidence.',
            createdAt: 10,
            id: `artifact-${index}`,
            kind: ExecutionArtifactKind.PLAN,
            taskId: worktree.taskId,
          }),
        ),
      },
    ],
    [
      'Quality Gate',
      {
        qualityGateRuns: Array.from({ length: 1_001 }, (_, index) =>
          completeQualityGateRun(
            startQualityGateRun({
              gate,
              id: `gate-run-${index}`,
              startedAt: 30,
              taskId: worktree.taskId,
              worktree: {
                baseCommitId: codeState.baseCommitId,
                branchName: codeState.branchName,
                headCommitIdAtStart: codeState.headCommitId,
                pathIdentity: codeState.worktreePathIdentity,
                worktreePath: worktree.worktreePath,
              },
            }),
            {
              exitCode: 0,
              finishedAt: 40,
              kind: 'exited',
              output: {
                reference: `quality-gate-output:gate-run-${index}`,
                text: 'passed',
                truncated: false,
              },
            },
          ),
        ),
      },
    ],
  ])(
    'rejects an over-limit %s history as an explicit readiness failure',
    async (_kind, options) => {
      const current = fixture(options);

      await expect(
        requestTaskReview(
          { reviewId: 'review-evidence-over-limit', taskId: worktree.taskId },
          current.dependencies,
        ),
      ).rejects.toMatchObject({
        name: 'TaskReviewReadinessError',
        reason: 'EVIDENCE_LIMIT_EXCEEDED',
        taskId: worktree.taskId,
      });
      await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
        phase: TaskPhase.RUNNING,
      });
      expect(current.codeInspector.calls).toBe(0);
      expect(current.artifacts.listAllCalls).toBe(0);
      expect(current.qualityGateRuns.listAllCalls).toBe(0);
      await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toEqual([]);
    },
  );

  it.each([
    [
      'Artifact',
      {
        artifacts: Array.from({ length: 1_000 }, (_, index) =>
          createExecutionArtifact({
            content: '# Plan\n\nBounded review evidence.',
            createdAt: 10,
            id: `artifact-at-limit-${index}`,
            kind: ExecutionArtifactKind.PLAN,
            taskId: worktree.taskId,
          }),
        ),
        expectedArtifacts: 1_000,
        expectedGates: 1,
      },
    ],
    [
      'Quality Gate',
      {
        expectedArtifacts: 2,
        expectedGates: 1_000,
        qualityGateRuns: Array.from({ length: 1_000 }, (_, index) =>
          completeQualityGateRun(
            startQualityGateRun({
              gate,
              id: `gate-at-limit-${index}`,
              startedAt: 30,
              taskId: worktree.taskId,
              worktree: {
                baseCommitId: codeState.baseCommitId,
                branchName: codeState.branchName,
                headCommitIdAtStart: codeState.headCommitId,
                pathIdentity: codeState.worktreePathIdentity,
                worktreePath: worktree.worktreePath,
              },
            }),
            {
              exitCode: 0,
              finishedAt: 40,
              kind: 'exited',
              output: {
                reference: `quality-gate-output:gate-at-limit-${index}`,
                text: 'passed',
                truncated: false,
              },
            },
          ),
        ),
      },
    ],
  ])('admits exactly the configured %s evidence limit', async (_kind, options) => {
    const current = fixture(options);

    const result = await requestTaskReview(
      { reviewId: 'review-evidence-at-limit', taskId: worktree.taskId },
      current.dependencies,
    );

    expect(result.review.artifacts).toHaveLength(options.expectedArtifacts);
    expect(result.review.qualityGates).toHaveLength(options.expectedGates);
    expect(current.artifacts.listAllCalls).toBe(0);
    expect(current.qualityGateRuns.listAllCalls).toBe(0);
  });

  it('rejects Review admission while a Quality Gate run is still active', async () => {
    const runningGate = startQualityGateRun({
      gate,
      id: 'gate-run-active',
      startedAt: 30,
      taskId: worktree.taskId,
      worktree: {
        baseCommitId: codeState.baseCommitId,
        branchName: codeState.branchName,
        headCommitIdAtStart: codeState.headCommitId,
        pathIdentity: codeState.worktreePathIdentity,
        worktreePath: worktree.worktreePath,
      },
    });
    const current = fixture({ qualityGateRuns: [runningGate] });

    await expect(
      requestTaskReview(
        { reviewId: 'review-active-gate', taskId: worktree.taskId },
        current.dependencies,
      ),
    ).rejects.toMatchObject({
      name: 'TaskReviewReadinessError',
      reason: 'ACTIVE_QUALITY_GATE',
      taskId: worktree.taskId,
    });
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: TaskPhase.RUNNING,
    });
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toEqual([]);
  });

  it('returns the stored pending attempt when a successful Review request is retried', async () => {
    const current = fixture();
    const first = await requestTaskReview(
      { reviewId: 'review-request-retry', taskId: worktree.taskId },
      current.dependencies,
    );

    const retried = await requestTaskReview(
      { reviewId: first.review.id, taskId: worktree.taskId },
      current.dependencies,
    );

    expect(retried).toEqual(first);
    expect(current.codeInspector.calls).toBe(1);
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toHaveLength(1);
  });

  it('rejects an active Agent Session before reading or storing review code evidence', async () => {
    const current = fixture({ sessions: [activeSession()] });

    await expect(
      requestTaskReview(
        { reviewId: 'review-active', taskId: worktree.taskId },
        current.dependencies,
      ),
    ).rejects.toMatchObject({
      name: 'TaskReviewReadinessError',
      reason: 'ACTIVE_SESSION',
      taskId: worktree.taskId,
    });
    expect(current.codeInspector.calls).toBe(0);
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: 'RUNNING',
    });
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toEqual([]);
  });

  it('requires process-exit evidence after a fatal runtime failure before Review admission', async () => {
    const unsettled = fixture({ sessions: [failedRuntimeSession(false)] });

    await expect(
      requestTaskReview(
        { reviewId: 'review-runtime-owned', taskId: worktree.taskId },
        unsettled.dependencies,
      ),
    ).rejects.toMatchObject({
      name: 'TaskReviewReadinessError',
      reason: 'ACTIVE_SESSION',
    });
    expect(unsettled.codeInspector.calls).toBe(0);

    const exited = fixture({ sessions: [failedRuntimeSession(true)] });
    await expect(
      requestTaskReview(
        { reviewId: 'review-runtime-exited', taskId: worktree.taskId },
        exited.dependencies,
      ),
    ).resolves.toMatchObject({
      review: { status: TaskReviewStatus.PENDING },
      task: { phase: TaskPhase.REVIEW },
    });
  });

  it('accepts durable runtime-ownership-loss evidence after restart', async () => {
    const current = fixture({ sessions: [runtimeOwnershipLostSession()] });

    await expect(
      requestTaskReview(
        { reviewId: 'review-runtime-ownership-lost', taskId: worktree.taskId },
        current.dependencies,
      ),
    ).resolves.toMatchObject({
      review: { status: TaskReviewStatus.PENDING },
      task: { phase: TaskPhase.REVIEW },
    });
  });

  it('rejects a missing or non-PRESENT Worktree without changing phase or history', async () => {
    const current = fixture();
    current.dependencies.worktrees.record = { ...presentRecord, lifecycleState: 'PROVISIONING' };
    current.git.inspection = { kind: 'missing', worktree };

    await expect(
      requestTaskReview(
        { reviewId: 'review-no-worktree', taskId: worktree.taskId },
        current.dependencies,
      ),
    ).rejects.toBeInstanceOf(TaskReviewReadinessError);
    expect(current.codeInspector.calls).toBe(0);
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: 'RUNNING',
    });
  });

  it('captures a first structured attempt in-place for a legacy REVIEW Task', async () => {
    const current = fixture({ phase: TaskPhase.REVIEW });

    const result = await requestTaskReview(
      { reviewId: 'review-legacy-recovery', taskId: worktree.taskId },
      current.dependencies,
    );

    expect(result).toMatchObject({
      review: { id: 'review-legacy-recovery', status: TaskReviewStatus.PENDING },
      task: { phase: TaskPhase.REVIEW },
    });
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toHaveLength(1);
  });

  it.each([TaskPhase.BACKLOG, TaskPhase.PLANNING, TaskPhase.DONE])(
    'rejects invalid %s -> REVIEW before Worktree inspection',
    async (phase) => {
      const current = fixture({ phase });

      await expect(
        requestTaskReview(
          { reviewId: `review-invalid-${phase}`, taskId: worktree.taskId },
          current.dependencies,
        ),
      ).rejects.toMatchObject({
        name: 'InvalidTaskPhaseTransitionError',
        from: phase,
        to: 'REVIEW',
      });
      expect(current.codeInspector.calls).toBe(0);
    },
  );
});

describe('approveTaskReview', () => {
  it('revalidates the captured code state and records explicit approval with REVIEW -> DONE', async () => {
    const current = fixture();
    const requested = await requestTaskReview(
      { reviewId: 'review-approve', taskId: worktree.taskId },
      current.dependencies,
    );

    const approved = await approveTaskReview(
      {
        decisionNote: 'Reviewed and approved by the user.',
        reviewId: requested.review.id,
        taskId: worktree.taskId,
      },
      current.dependencies,
    );

    expect(approved.task.phase).toBe(TaskPhase.DONE);
    expect(approved.review).toMatchObject({
      decisionNote: 'Reviewed and approved by the user.',
      status: TaskReviewStatus.APPROVED,
    });
    expect(current.codeInspector.calls).toBe(2);
    expect(requested.review.status).toBe(TaskReviewStatus.PENDING);
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toEqual([approved.review]);
  });

  it('rejects stale code even when HEAD and changed paths are unchanged', async () => {
    const current = fixture();
    const requested = await requestTaskReview(
      { reviewId: 'review-stale', taskId: worktree.taskId },
      current.dependencies,
    );
    current.codeInspector.value = { ...codeState, fingerprint: 'e'.repeat(64) };

    await expect(
      approveTaskReview(
        { reviewId: requested.review.id, taskId: worktree.taskId },
        current.dependencies,
      ),
    ).rejects.toMatchObject({
      name: 'TaskReviewReadinessError',
      reason: 'STALE_CODE_STATE',
    });
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: 'REVIEW',
    });
    await expect(current.reviews.findById(requested.review.id)).resolves.toMatchObject({
      status: 'PENDING',
    });
  });

  it('returns the stored approval when the same accepted user decision is retried', async () => {
    const current = fixture();
    const requested = await requestTaskReview(
      { reviewId: 'review-approve-retry', taskId: worktree.taskId },
      current.dependencies,
    );
    const input = {
      decisionNote: 'Approved once.',
      reviewId: requested.review.id,
      taskId: worktree.taskId,
    };
    const approved = await approveTaskReview(input, current.dependencies);

    await expect(approveTaskReview(input, current.dependencies)).resolves.toEqual(approved);
    await expect(
      approveTaskReview({ ...input, decisionNote: 'Conflicting retry.' }, current.dependencies),
    ).rejects.toThrow();
    expect(current.codeInspector.calls).toBe(2);
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toHaveLength(1);
  });

  it('rejects a missing, wrong-Task, or already-decided review without changing Task state', async () => {
    const current = fixture();
    const requested = await requestTaskReview(
      { reviewId: 'review-invalid-decision', taskId: worktree.taskId },
      current.dependencies,
    );

    await expect(
      approveTaskReview(
        { reviewId: 'missing-review', taskId: worktree.taskId },
        current.dependencies,
      ),
    ).rejects.toMatchObject({ entity: 'TaskReview', id: 'missing-review' });
    await expect(
      approveTaskReview(
        { reviewId: requested.review.id, taskId: 'another-task' },
        current.dependencies,
      ),
    ).rejects.toThrow();

    const terminal = decideTaskReview(requested.review, {
      decidedAt: 60,
      status: TaskReviewStatus.CHANGES_REQUESTED,
    });
    await current.reviews.decide(
      terminal,
      TaskReviewStatus.PENDING,
      TaskPhase.REVIEW,
      transitionTask(requested.task, TaskPhase.RUNNING),
    );
    current.tasks.replace(transitionTask(taskAt(TaskPhase.RUNNING), TaskPhase.REVIEW));
    await expect(
      approveTaskReview({ reviewId: terminal.id, taskId: worktree.taskId }, current.dependencies),
    ).rejects.toMatchObject({ name: 'InvalidTaskReviewTransitionError' });
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: 'REVIEW',
    });
  });
});

describe('requestTaskChanges', () => {
  it('records requested changes, returns REVIEW -> RUNNING, and preserves every prior history', async () => {
    const current = fixture();
    const first = await requestTaskReview(
      { reviewId: 'review-first', taskId: worktree.taskId },
      current.dependencies,
    );
    current.codeInspector.value = { ...codeState, fingerprint: 'd'.repeat(64) };

    const changes = await requestTaskChanges(
      {
        decisionNote: 'Please address the remaining lifecycle race.',
        reviewId: first.review.id,
        taskId: worktree.taskId,
      },
      current.dependencies,
    );

    expect(changes.task.phase).toBe(TaskPhase.RUNNING);
    expect(changes.review).toMatchObject({
      decisionNote: 'Please address the remaining lifecycle race.',
      status: TaskReviewStatus.CHANGES_REQUESTED,
    });
    expect(current.codeInspector.calls).toBe(1);
    expect(await current.dependencies.artifacts.listByTaskId(worktree.taskId)).toEqual([
      plan,
      summary,
    ]);
    expect(await current.dependencies.qualityGateRuns.listByTaskId(worktree.taskId)).toEqual([
      passedGate,
    ]);
    expect(await current.dependencies.sessions.listByTaskId(worktree.taskId)).toEqual([
      exitedSession(),
    ]);
    expect(current.dependencies.worktrees.record).toEqual(presentRecord);

    current.codeInspector.value = codeState;
    const second = await requestTaskReview(
      { reviewId: 'review-second', taskId: worktree.taskId },
      current.dependencies,
    );
    expect(second.review.id).toBe('review-second');
    await expect(
      listTaskReviews(worktree.taskId, current.tasks, current.reviews),
    ).resolves.toMatchObject([
      { id: 'review-first', status: 'CHANGES_REQUESTED' },
      { id: 'review-second', status: 'PENDING' },
    ]);
  });

  it('rejects invalid source phases and never turns an agent or gate claim into DONE', async () => {
    const current = fixture({ phase: TaskPhase.RUNNING });

    await expect(
      requestTaskChanges(
        { reviewId: 'missing-review', taskId: worktree.taskId },
        current.dependencies,
      ),
    ).rejects.toMatchObject({
      name: 'InvalidTaskPhaseTransitionError',
      from: TaskPhase.RUNNING,
      to: TaskPhase.RUNNING,
    });
    await expect(current.tasks.findById(worktree.taskId)).resolves.toMatchObject({
      phase: 'RUNNING',
    });
  });

  it('returns the stored changes request when the same accepted decision is retried', async () => {
    const current = fixture();
    const requested = await requestTaskReview(
      { reviewId: 'review-changes-retry', taskId: worktree.taskId },
      current.dependencies,
    );
    const input = {
      decisionNote: 'Please revise once.',
      reviewId: requested.review.id,
      taskId: worktree.taskId,
    };
    const changes = await requestTaskChanges(input, current.dependencies);

    await expect(requestTaskChanges(input, current.dependencies)).resolves.toEqual(changes);
    await expect(
      requestTaskChanges({ reviewId: input.reviewId, taskId: input.taskId }, current.dependencies),
    ).rejects.toThrow();
    await expect(current.reviews.listByTaskId(worktree.taskId)).resolves.toHaveLength(1);
  });
});

function isTerminal(session: AgentSession): boolean {
  return (
    session.status === AgentSessionStatus.EXITED || session.status === AgentSessionStatus.FAILED
  );
}
