import { describe, expect, it } from 'vitest';

import {
  completeQualityGateRun,
  createAgentSession,
  createExecutionArtifact,
  createQualityGate,
  createTask,
  decideTaskReview,
  QualityGateKind,
  recordAgentSessionEvent,
  startTaskReview,
  startQualityGateRun,
  TaskPhase,
  TaskReviewGateAssociation,
  TaskReviewStatus,
  transitionTask,
  type AgentSession,
  type ExecutionArtifact,
  type QualityGateRun,
  type Task,
  type TaskReview,
} from '@agentterm/domain';

import {
  loadAgentWorkspace,
  type AgentSessionRepository,
  type ExecutionArtifactRepository,
  type LocalProject,
  type ProjectCatalog,
  type QualityGateRunRepository,
  type TaskCatalog,
  type TaskReviewRepository,
  type TaskReviewQualityGateEvidenceSource,
} from './index';

class FakeProjectCatalog implements ProjectCatalog {
  public constructor(private readonly projects: readonly LocalProject[]) {}

  public async listRecent(): Promise<readonly LocalProject[]> {
    return this.projects;
  }

  public async recordOpen(): Promise<never> {
    throw new Error('recordOpen is not used by the workspace overview');
  }
}

class FakeTaskCatalog implements TaskCatalog {
  public constructor(private readonly tasks: readonly Task[]) {}

  public async listByProjectId(projectId: string): Promise<readonly Task[]> {
    return this.tasks.filter((task) => task.projectId === projectId);
  }
}

class FakeSessionRepository implements AgentSessionRepository {
  public constructor(private readonly sessions: readonly AgentSession[]) {}

  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.sessions.find((session) => session.id === id);
  }

  public async insert(): Promise<never> {
    throw new Error('insert is not used by the workspace overview');
  }

  public async append(): Promise<never> {
    throw new Error('append is not used by the workspace overview');
  }

  public async listActive(): Promise<readonly AgentSession[]> {
    return this.sessions.filter(
      (session) => session.status !== 'EXITED' && session.status !== 'FAILED',
    );
  }

  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return this.sessions.filter((session) => session.taskId === taskId);
  }
}

class FakeQualityGateRunRepository implements QualityGateRunRepository {
  public listAllCalls = 0;
  public readonly recentLimits: number[] = [];
  public readonly reviewEvidenceLimits: number[] = [];
  public constructor(private readonly runs: readonly QualityGateRun[]) {}

  public async findById(id: string): Promise<QualityGateRun | undefined> {
    return this.runs.find((run) => run.id === id);
  }

  public async insert(): Promise<never> {
    throw new Error('insert is not used by the workspace overview');
  }

  public async finalize(): Promise<never> {
    throw new Error('finalize is not used by the workspace overview');
  }

  public async listByTaskId(taskId: string): Promise<readonly QualityGateRun[]> {
    this.listAllCalls += 1;
    return this.runs.filter((run) => run.taskId === taskId);
  }

  public async listRecentByTaskId(taskId: string, limit: number) {
    this.recentLimits.push(limit);
    return this.runs.filter((run) => run.taskId === taskId).slice(-limit);
  }

  public async readReviewEvidenceByTaskId(taskId: string, limit: number) {
    this.reviewEvidenceLimits.push(limit);
    const runs = this.runs.filter((run) => run.taskId === taskId);
    return {
      evidence:
        runs.length > limit
          ? []
          : runs.map(
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
      hasRunning: runs.some(({ status }) => status === 'RUNNING'),
      totalCount: runs.length,
    };
  }
}

class FakeArtifactRepository implements ExecutionArtifactRepository {
  public listAllCalls = 0;
  public readonly recentLimits: number[] = [];
  public readonly reviewEvidenceLimits: number[] = [];
  public constructor(private readonly artifacts: readonly ExecutionArtifact[]) {}

  public async findById(id: string): Promise<ExecutionArtifact | undefined> {
    return this.artifacts.find((artifact) => artifact.id === id);
  }

  public async insert(): Promise<never> {
    throw new Error('insert is not used by the workspace overview');
  }

  public async listByTaskId(taskId: string): Promise<readonly ExecutionArtifact[]> {
    this.listAllCalls += 1;
    return this.artifacts.filter((artifact) => artifact.taskId === taskId);
  }

  public async listRecentByTaskId(taskId: string, limit: number) {
    this.recentLimits.push(limit);
    return this.artifacts.filter((artifact) => artifact.taskId === taskId).slice(-limit);
  }

  public async readReviewEvidenceByTaskId(taskId: string, limit: number) {
    this.reviewEvidenceLimits.push(limit);
    const artifacts = this.artifacts.filter((artifact) => artifact.taskId === taskId);
    return {
      evidence:
        artifacts.length > limit
          ? []
          : artifacts.map(({ createdAt, id, kind, phase, sessionId }) => ({
              createdAt,
              id,
              kind,
              phase,
              sessionId,
            })),
      totalCount: artifacts.length,
    };
  }
}

class FakeTaskReviewRepository implements TaskReviewRepository {
  public listAllCalls = 0;
  public readonly recentLimits: number[] = [];

  public constructor(private readonly reviews: readonly TaskReview[]) {}

  public async findById(id: string): Promise<TaskReview | undefined> {
    return this.reviews.find((review) => review.id === id);
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskReview[]> {
    this.listAllCalls += 1;
    return this.reviews.filter((review) => review.taskId === taskId);
  }

  public async listRecentByTaskId(taskId: string, limit: number): Promise<readonly TaskReview[]> {
    this.recentLimits.push(limit);
    return this.reviews.filter((review) => review.taskId === taskId).slice(-limit);
  }

  public async begin(): Promise<never> {
    throw new Error('begin is not used by the workspace overview');
  }

  public async decide(): Promise<never> {
    throw new Error('decide is not used by the workspace overview');
  }
}

describe('loadAgentWorkspace', () => {
  it('groups Tasks under recent Projects and keeps Task phase separate from active/latest Session status', async () => {
    const project: LocalProject = {
      id: 'project-vietnamese',
      name: 'Dự án tiếng Việt',
      rootPath: 'D:\\Repositories\\Dự án',
    };
    const runningTask = transitionTask(
      transitionTask(
        createTask({ id: 'task-running', projectId: project.id, title: 'Sửa Unicode' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const secondTask = transitionTask(
      transitionTask(
        createTask({ id: 'task-history', projectId: project.id, title: 'Giữ lịch sử' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const exited = exitSession(startSession('session-exited', runningTask.id, 100), 0, 101);
    const working = workSession(startSession('session-working', runningTask.id, 102), 103);
    const olderActive = workSession(startSession('session-active', secondTask.id, 104), 105);
    const latestFailed = failSession(startSession('session-failed', secondTask.id, 106), 107);
    const lintPassed = completeQualityGateRun(startGateRun('gate-run-lint', runningTask.id, 200), {
      exitCode: 0,
      finishedAt: 320,
      kind: 'exited',
      output: { reference: 'output-lint', text: 'lint passed', truncated: false },
    });
    const testsFailed = completeQualityGateRun(
      startGateRun('gate-run-test', runningTask.id, 400, QualityGateKind.TEST),
      {
        exitCode: 1,
        finishedAt: 1_650,
        kind: 'exited',
        output: {
          reference: 'output-test',
          text: 'Ki\u1ec3m th\u1eed th\u1ea5t b\u1ea1i',
          truncated: true,
        },
      },
    );
    const plan = createExecutionArtifact({
      content: '# Plan\n\nGiữ Task phase và Session status riêng biệt.',
      createdAt: 108,
      id: 'artifact-plan',
      kind: 'plan',
      sessionId: exited.id,
      taskId: runningTask.id,
    });
    const summary = createExecutionArtifact({
      content: '# Execution Summary\n\nĐã hoàn thành execution slice, chưa hoàn thành Task.',
      createdAt: 109,
      id: 'artifact-summary',
      kind: 'execution-summary',
      sessionId: working.id,
      taskId: runningTask.id,
    });

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([runningTask, secondTask]),
      new FakeSessionRepository([exited, working, olderActive, latestFailed]),
      new FakeArtifactRepository([plan, summary]),
      new FakeQualityGateRunRepository([lintPassed, testsFailed]),
      new FakeTaskReviewRepository([]),
    );

    const projectSummary = { id: project.id, name: project.name };
    const workingSummary = summarize(working);
    const olderActiveSummary = summarize(olderActive);
    const latestFailedSummary = summarize(latestFailed);
    expect(workspace).toEqual({
      projects: [
        {
          project: projectSummary,
          tasks: [
            {
              activeSession: workingSummary,
              artifacts: [plan, summary],
              canRetryExecution: false,
              canStartExecution: false,
              canApproveReview: false,
              canRequestChanges: false,
              canRequestReview: false,
              latestSession: workingSummary,
              latestReview: undefined,
              previousSession: summarize(exited),
              qualityGateRuns: [summarizeGateRun(lintPassed), summarizeGateRun(testsFailed)],
              reviewHistory: [],
              task: runningTask,
            },
            {
              activeSession: olderActiveSummary,
              artifacts: [],
              canRetryExecution: false,
              canStartExecution: false,
              canApproveReview: false,
              canRequestChanges: false,
              canRequestReview: false,
              latestSession: latestFailedSummary,
              latestReview: undefined,
              previousSession: olderActiveSummary,
              qualityGateRuns: [],
              reviewHistory: [],
              task: secondTask,
            },
          ],
        },
      ],
    });
    expect(workspace.projects[0]?.project).not.toHaveProperty('rootPath');
    expect(workspace.projects[0]?.tasks[0]?.latestSession).not.toHaveProperty('history');
    expect(workspace.projects[0]?.tasks[0]).toMatchObject({
      activeSession: { status: 'WORKING' },
      latestSession: { status: 'WORKING' },
      task: { phase: 'RUNNING' },
    });
    expect(workspace.projects[0]?.tasks[1]).toMatchObject({
      activeSession: { status: 'WORKING' },
      latestSession: { failureCode: 'RUNTIME_FAILURE', status: 'FAILED' },
      task: { phase: 'RUNNING' },
    });
    expect(workspace.projects[0]?.tasks[0]?.qualityGateRuns[0]).not.toHaveProperty('gate');
    expect(workspace.projects[0]?.tasks[0]?.qualityGateRuns[0]).not.toHaveProperty('worktree');
    expect(workspace.projects[0]?.tasks[0]?.qualityGateRuns[0]?.output).not.toHaveProperty(
      'reference',
    );
  });

  it('bounds gate evidence copied into the workspace read model', async () => {
    const project: LocalProject = {
      id: 'project-bounded-gates',
      name: 'Bounded gates',
      rootPath: 'D:\\Repositories\\Bounded gates',
    };
    const runningTask = transitionTask(
      transitionTask(
        createTask({ id: 'task-bounded-gates', projectId: project.id, title: 'Gate history' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const gateRuns = Array.from({ length: 21 }, (_, index) =>
      completeQualityGateRun(startGateRun(`gate-run-${index}`, runningTask.id, index), {
        exitCode: 0,
        finishedAt: index + 1,
        kind: 'exited',
        output: {
          reference: `quality-gate-output:gate-run-${index}`,
          text: 'x'.repeat(5_000),
          truncated: false,
        },
      }),
    );
    const artifactRepository = new FakeArtifactRepository([]);
    const gateRepository = new FakeQualityGateRunRepository(gateRuns);

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([runningTask]),
      new FakeSessionRepository([]),
      artifactRepository,
      gateRepository,
      new FakeTaskReviewRepository([]),
    );
    const summaries = workspace.projects[0]?.tasks[0]?.qualityGateRuns;

    expect(summaries).toHaveLength(20);
    expect(summaries?.[0]?.id).toBe('gate-run-1');
    expect(summaries?.at(-1)?.output).toEqual({ text: 'x'.repeat(4_096), truncated: true });
    expect(gateRepository.listAllCalls).toBe(0);
    expect(gateRepository.recentLimits).toEqual([20]);
    expect(gateRepository.reviewEvidenceLimits).toEqual([0]);
    expect(artifactRepository.listAllCalls).toBe(0);
    expect(artifactRepository.recentLimits).toEqual([20]);
    expect(artifactRepository.reviewEvidenceLimits).toEqual([0]);
  });

  it('loads only the 20 newest Artifact payloads for workspace display', async () => {
    const project: LocalProject = {
      id: 'project-bounded-artifacts',
      name: 'Bounded artifacts',
      rootPath: 'D:\\Repositories\\Bounded artifacts',
    };
    const runningTask = transitionTask(
      transitionTask(
        createTask({
          id: 'task-bounded-artifacts',
          projectId: project.id,
          title: 'Artifact history',
        }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const artifacts = Array.from({ length: 21 }, (_, index) =>
      createExecutionArtifact({
        content: `# Plan\n\nArtifact ${index}.`,
        createdAt: index,
        id: `artifact-${index}`,
        kind: 'plan',
        taskId: runningTask.id,
      }),
    );
    const artifactRepository = new FakeArtifactRepository(artifacts);

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([runningTask]),
      new FakeSessionRepository([]),
      artifactRepository,
      new FakeQualityGateRunRepository([]),
      new FakeTaskReviewRepository([]),
    );

    expect(workspace.projects[0]?.tasks[0]?.artifacts).toHaveLength(20);
    expect(workspace.projects[0]?.tasks[0]?.artifacts[0]?.id).toBe('artifact-1');
    expect(workspace.projects[0]?.tasks[0]?.artifacts.at(-1)?.id).toBe('artifact-20');
    expect(artifactRepository.listAllCalls).toBe(0);
    expect(artifactRepository.recentLimits).toEqual([20]);
    expect(artifactRepository.reviewEvidenceLimits).toEqual([0]);
  });

  it('preserves recent Projects that do not have Tasks', async () => {
    const emptyProject: LocalProject = {
      id: 'project-empty',
      name: 'Empty Project',
      rootPath: 'D:\\Repositories\\Empty',
    };

    await expect(
      loadAgentWorkspace(
        new FakeProjectCatalog([emptyProject]),
        new FakeTaskCatalog([]),
        new FakeSessionRepository([]),
        new FakeArtifactRepository([]),
        new FakeQualityGateRunRepository([]),
        new FakeTaskReviewRepository([]),
      ),
    ).resolves.toEqual({
      projects: [{ project: { id: emptyProject.id, name: emptyProject.name }, tasks: [] }],
    });
  });

  it('publishes execution availability from Application policy instead of Presentation inference', async () => {
    const project: LocalProject = {
      id: 'project-policy',
      name: 'Policy',
      rootPath: 'D:\\Repositories\\Policy',
    };
    const backlog = createTask({ id: 'backlog', projectId: project.id, title: 'Backlog' });
    const planning = transitionTask(
      createTask({ id: 'planning', projectId: project.id, title: 'Planning' }),
      TaskPhase.PLANNING,
    );

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([backlog, planning]),
      new FakeSessionRepository([]),
      new FakeArtifactRepository([]),
      new FakeQualityGateRunRepository([]),
      new FakeTaskReviewRepository([]),
    );

    expect(workspace.projects[0]?.tasks).toMatchObject([
      { canRetryExecution: false, canStartExecution: false, task: { phase: 'BACKLOG' } },
      { canRetryExecution: false, canStartExecution: true, task: { phase: 'PLANNING' } },
    ]);
  });

  it('offers retry only for an eligible Task whose latest Session is terminal', async () => {
    const project: LocalProject = {
      id: 'project-retry',
      name: 'Recovery',
      rootPath: 'D:\\Repositories\\Recovery',
    };
    const running = transitionTask(
      transitionTask(
        createTask({ id: 'retry', projectId: project.id, title: 'Retry safely' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const failed = failSession(startSession('session-failed', running.id, 100), 101);

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([running]),
      new FakeSessionRepository([failed]),
      new FakeArtifactRepository([]),
      new FakeQualityGateRunRepository([]),
      new FakeTaskReviewRepository([]),
    );

    expect(workspace.projects[0]?.tasks[0]).toMatchObject({
      activeSession: undefined,
      artifacts: [],
      canRetryExecution: false,
      canStartExecution: false,
      canApproveReview: false,
      canRequestChanges: false,
      canRequestReview: false,
      latestSession: { id: failed.id, status: 'FAILED' },
      latestReview: undefined,
      previousSession: undefined,
      reviewHistory: [],
      task: { phase: 'RUNNING' },
    });
  });

  it('does not advertise Review readiness while a gate or failed runtime writer is unsettled', async () => {
    const project: LocalProject = {
      id: 'project-review-readiness',
      name: 'Review readiness',
      rootPath: 'D:\\Repositories\\Review readiness',
    };
    const running = transitionTask(
      transitionTask(
        createTask({ id: 'review-readiness', projectId: project.id, title: 'Wait for writers' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const failedWriter = failSession(startSession('session-failed-writer', running.id, 100), 101);
    const runningGate = startGateRun('gate-run-active', running.id, 200);

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([running]),
      new FakeSessionRepository([failedWriter]),
      new FakeArtifactRepository([]),
      new FakeQualityGateRunRepository([runningGate]),
      new FakeTaskReviewRepository([]),
    );

    expect(workspace.projects[0]?.tasks[0]).toMatchObject({
      activeSession: undefined,
      canRequestReview: false,
      latestSession: { id: failedWriter.id, status: 'FAILED' },
      qualityGateRuns: [{ id: runningGate.id, status: 'RUNNING' }],
    });
  });

  it('publishes explicit Review actions and a safe immutable evidence snapshot', async () => {
    const project: LocalProject = {
      id: 'project-review',
      name: 'Review policy',
      rootPath: 'D:\\Repositories\\Review',
    };
    const running = transitionTask(
      transitionTask(
        createTask({ id: 'task-review', projectId: project.id, title: 'Review safely' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const reviewTask = transitionTask(running, TaskPhase.REVIEW);
    const oldReview = decideTaskReview(createReview('review-old', reviewTask.id, 100), {
      decidedAt: 110,
      decisionNote: 'Needs another pass.',
      status: TaskReviewStatus.CHANGES_REQUESTED,
    });
    const capturedPending = createReview('review-pending', reviewTask.id, 200, {
      committed: [
        'src/review.ts',
        'D:\\private\\must-not-render.ts',
        'C:drive-relative.ts',
        '\\\\server\\share\\private.ts',
        '/rooted/private.ts',
        '\\rooted\\private.ts',
        '../parent/private.ts',
        'src/../../escaped.ts',
      ],
      conflicted: [],
      staged: [],
      total: 8,
      truncated: false,
      unstaged: [],
      untracked: [],
    });
    // Simulate an untrusted persisted row that predates current Domain validation.
    const pending = {
      ...capturedPending,
      codeState: {
        ...capturedPending.codeState,
        changes: {
          ...capturedPending.codeState.changes,
          committed: [...capturedPending.codeState.changes.committed, 'nul\0private.ts'],
          total: 9,
        },
      },
    } as TaskReview;

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([reviewTask]),
      new FakeSessionRepository([]),
      new FakeArtifactRepository([]),
      new FakeQualityGateRunRepository([]),
      new FakeTaskReviewRepository([oldReview, pending]),
    );
    const overview = workspace.projects[0]?.tasks[0];

    expect(overview).toMatchObject({
      canApproveReview: true,
      canRequestChanges: true,
      canRequestReview: false,
      latestReview: {
        artifacts: [
          {
            createdAt: 10,
            id: 'artifact-summary',
            kind: 'execution-summary',
            phase: 'RUNNING',
            sessionId: 'session-1',
          },
        ],
        codeState: {
          branchName: 'agentterm/task/review',
          changes: {
            committed: ['src/review.ts'],
            total: 9,
            truncated: true,
          },
          fingerprint: 'f'.repeat(64),
          headCommitId: 'b'.repeat(40),
        },
        freshness: 'REVALIDATE_ON_APPROVAL',
        id: 'review-pending',
        qualityGates: [
          {
            association: 'HEAD_MATCH_ONLY',
            gateId: 'lint',
            id: 'gate-run-lint',
            observedStatus: 'PASSED',
          },
          {
            association: 'STALE',
            gateId: 'test',
            id: 'gate-run-test',
            observedStatus: 'FAILED',
          },
        ],
        status: 'PENDING',
      },
      reviewHistory: [
        { id: 'review-pending', status: 'PENDING' },
        { id: 'review-old', status: 'CHANGES_REQUESTED' },
      ],
      task: { phase: 'REVIEW' },
    });
    expect(overview?.latestReview).toBe(overview?.reviewHistory[0]);
    expect(Object.isFrozen(overview?.reviewHistory)).toBe(true);
    expect(Object.isFrozen(overview?.latestReview)).toBe(true);
    expect(Object.isFrozen(overview?.latestReview?.codeState)).toBe(true);
    expect(Object.isFrozen(overview?.latestReview?.codeState.changes.committed)).toBe(true);
    expect(Object.isFrozen(overview?.latestReview?.artifacts[0])).toBe(true);
    expect(Object.isFrozen(overview?.latestReview?.qualityGates[0])).toBe(true);
    expect(JSON.stringify(overview?.latestReview)).not.toContain('worktreePathIdentity');
    expect(JSON.stringify(overview?.latestReview)).not.toContain('D:\\private');
    expect(JSON.stringify(overview?.latestReview)).not.toContain('worktreePath');
    expect(JSON.stringify(overview?.latestReview)).not.toContain('executablePath');
    expect(JSON.stringify(overview?.latestReview)).not.toContain('output');
  });

  it('bounds Review history to the 20 newest immutable attempts', async () => {
    const project: LocalProject = {
      id: 'project-review-history',
      name: 'Review history',
      rootPath: 'D:\\Repositories\\Review history',
    };
    const running = transitionTask(
      transitionTask(
        createTask({ id: 'review-history', projectId: project.id, title: 'Keep history' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const reviews = Array.from({ length: 21 }, (_, index) =>
      decideTaskReview(createReview(`review-${index}`, running.id, index + 100), {
        decidedAt: index + 200,
        status: TaskReviewStatus.APPROVED,
      }),
    );
    const reviewRepository = new FakeTaskReviewRepository(reviews);

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([running]),
      new FakeSessionRepository([]),
      new FakeArtifactRepository([]),
      new FakeQualityGateRunRepository([]),
      reviewRepository,
    );
    const reviewHistory = workspace.projects[0]?.tasks[0]?.reviewHistory;

    expect(reviewHistory).toHaveLength(20);
    expect(reviewHistory?.[0]?.id).toBe('review-20');
    expect(reviewHistory?.at(-1)?.id).toBe('review-1');
    expect(workspace.projects[0]?.tasks[0]?.latestReview?.id).toBe('review-20');
    expect(reviewRepository.listAllCalls).toBe(0);
    expect(reviewRepository.recentLimits).toEqual([20]);
  });

  it('offers explicit structured Review recovery for a legacy REVIEW Task with no history', async () => {
    const project: LocalProject = {
      id: 'project-legacy-review',
      name: 'Legacy Review',
      rootPath: 'D:\\Repositories\\Legacy Review',
    };
    const running = transitionTask(
      transitionTask(
        createTask({ id: 'legacy-review', projectId: project.id, title: 'Recover Review' }),
        TaskPhase.PLANNING,
      ),
      TaskPhase.RUNNING,
    );
    const review = transitionTask(running, TaskPhase.REVIEW);

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([review]),
      new FakeSessionRepository([]),
      new FakeArtifactRepository([]),
      new FakeQualityGateRunRepository([]),
      new FakeTaskReviewRepository([]),
    );

    expect(workspace.projects[0]?.tasks[0]).toMatchObject({
      canApproveReview: false,
      canRequestChanges: false,
      canRequestReview: true,
      reviewHistory: [],
      task: { phase: TaskPhase.REVIEW },
    });
  });
});

function startSession(id: string, taskId: string, createdAt: number): AgentSession {
  return createAgentSession({ agentId: 'codex', createdAt, id, taskId });
}

function workSession(session: AgentSession, occurredAt: number): AgentSession {
  return recordAgentSessionEvent(session, {
    kind: 'STATUS_REPORTED',
    occurredAt,
    runtimeSequence: 1,
    source: 'RUNTIME',
    status: 'WORKING',
  });
}

function exitSession(session: AgentSession, exitCode: number, occurredAt: number): AgentSession {
  return recordAgentSessionEvent(session, {
    exitCode,
    kind: 'PROCESS_EXITED',
    occurredAt,
    reason: 'PROCESS_EXIT',
    runtimeSequence: 1,
  });
}

function failSession(session: AgentSession, occurredAt: number): AgentSession {
  return recordAgentSessionEvent(session, {
    code: 'RUNTIME_FAILURE',
    fatal: true,
    kind: 'RUNTIME_FAILED',
    occurredAt,
    runtimeSequence: 1,
    stage: 'RUNTIME',
  });
}

function summarize(session: AgentSession) {
  const failure = [...session.history]
    .reverse()
    .find((event) => event.kind === 'RUNTIME_FAILED' && event.fatal);
  return {
    agentId: session.agentId,
    createdAt: session.createdAt,
    endedAt: session.endedAt,
    failureCode: failure?.kind === 'RUNTIME_FAILED' ? failure.code : undefined,
    id: session.id,
    status: session.status,
    taskId: session.taskId,
  };
}

function startGateRun(
  id: string,
  taskId: string,
  startedAt: number,
  kind: QualityGateRun['gate']['kind'] = QualityGateKind.LINT,
): QualityGateRun {
  return startQualityGateRun({
    gate: createQualityGate({
      command: { arguments: ['run', kind.toLowerCase()], executablePath: 'pnpm.cmd' },
      id: `gate-${kind.toLowerCase()}`,
      kind,
      timeoutMs: 60_000,
    }),
    id,
    startedAt,
    taskId,
    worktree: {
      baseCommitId: 'a'.repeat(40),
      branchName: 'agentterm/task-1',
      headCommitIdAtStart: 'b'.repeat(40),
      pathIdentity: 'worktree-identity',
      worktreePath: 'D:\\worktrees\\task-1',
    },
  });
}

function createReview(
  id: string,
  taskId: string,
  requestedAt: number,
  changes: TaskReview['codeState']['changes'] = {
    committed: ['src/review.ts'],
    conflicted: [],
    staged: [],
    total: 1,
    truncated: false,
    unstaged: [],
    untracked: [],
  },
): TaskReview {
  return startTaskReview({
    artifacts: [
      {
        createdAt: 10,
        id: 'artifact-summary',
        kind: 'execution-summary',
        phase: TaskPhase.RUNNING,
        sessionId: 'session-1',
      },
    ],
    codeState: {
      baseCommitId: 'a'.repeat(40),
      branchName: 'agentterm/task/review',
      changes,
      fingerprint: 'f'.repeat(64),
      headCommitId: 'b'.repeat(40),
      schemaVersion: 1,
      worktreePathIdentity: 'win32:d:\\agentterm-worktrees\\review',
    },
    id,
    qualityGates: [
      {
        association: TaskReviewGateAssociation.HEAD_MATCH_ONLY,
        baseCommitId: 'a'.repeat(40),
        branchName: 'agentterm/task/review',
        finishedAt: 20,
        gateId: 'lint',
        headCommitIdAtStart: 'b'.repeat(40),
        id: 'gate-run-lint',
        kind: QualityGateKind.LINT,
        observedStatus: 'PASSED',
        startedAt: 15,
        worktreePathIdentity: 'win32:d:\\agentterm-worktrees\\review',
      },
      {
        association: TaskReviewGateAssociation.STALE,
        baseCommitId: 'a'.repeat(40),
        branchName: 'agentterm/task/review',
        finishedAt: 25,
        gateId: 'test',
        headCommitIdAtStart: 'c'.repeat(40),
        id: 'gate-run-test',
        kind: QualityGateKind.TEST,
        observedStatus: 'FAILED',
        startedAt: 21,
        worktreePathIdentity: 'win32:d:\\agentterm-worktrees\\review',
      },
    ],
    requestedAt,
    taskId,
  });
}

function summarizeGateRun(run: QualityGateRun) {
  return {
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    failureCategory: run.failureCategory,
    finishedAt: run.finishedAt,
    gateId: run.gate.id,
    id: run.id,
    kind: run.gate.kind,
    output:
      run.output === undefined
        ? undefined
        : { text: run.output.text, truncated: run.output.truncated },
    startedAt: run.startedAt,
    status: run.status,
    taskId: run.taskId,
  };
}
