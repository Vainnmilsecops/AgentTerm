import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { AgentWorkspaceOverview, WorkspaceTaskOverview } from '@agentterm/application';

import { AgentWorkspaceView } from './agent-workspace';
import {
  WorkspaceController,
  type AgentWorkspaceClient,
  type WorkspaceSnapshot,
} from './workspace-controller';

const project = Object.freeze({
  id: 'project-1',
  name: 'Dự án AgentTerm',
});
const planningTask: WorkspaceTaskOverview['task'] = Object.freeze({
  id: 'task-1',
  phase: 'PLANNING',
  projectId: project.id,
  title: 'Nối terminal tiếng Việt',
});
const runningTask: WorkspaceTaskOverview['task'] = Object.freeze({
  ...planningTask,
  phase: 'RUNNING',
});
const failedSession: NonNullable<WorkspaceTaskOverview['latestSession']> = Object.freeze({
  agentId: 'codex',
  createdAt: 1_800_000_000_000,
  endedAt: 1_800_000_000_001,
  failureCode: 'RUNTIME_OWNERSHIP_LOST',
  id: 'session-failed',
  status: 'FAILED',
  taskId: runningTask.id,
});
const workingSession: NonNullable<WorkspaceTaskOverview['activeSession']> = Object.freeze({
  agentId: 'codex',
  createdAt: 1_800_000_000_000,
  endedAt: undefined,
  failureCode: undefined,
  id: 'session-working',
  status: 'WORKING',
  taskId: runningTask.id,
});
const passedLintRun: WorkspaceTaskOverview['qualityGateRuns'][number] = Object.freeze({
  durationMs: 120,
  exitCode: 0,
  failureCategory: undefined,
  finishedAt: 1_800_000_000_120,
  gateId: 'gate-lint',
  id: 'gate-run-lint',
  kind: 'LINT',
  output: Object.freeze({ text: 'Khong co loi lint.', truncated: false }),
  startedAt: 1_800_000_000_000,
  status: 'PASSED',
  taskId: runningTask.id,
});
const failedTestRun: WorkspaceTaskOverview['qualityGateRuns'][number] = Object.freeze({
  durationMs: 1_250,
  exitCode: 1,
  failureCategory: 'COMMAND',
  finishedAt: 1_800_000_002_250,
  gateId: 'gate-test',
  id: 'gate-run-test',
  kind: 'TEST',
  output: Object.freeze({
    text: 'Ki\u1ec3m th\u1eed th\u1ea5t b\u1ea1i: <script>secret()</script>',
    truncated: true,
  }),
  startedAt: 1_800_000_001_000,
  status: 'FAILED',
  taskId: runningTask.id,
});
const emptyReviewState = Object.freeze({
  canApproveReview: false,
  canRequestChanges: false,
  canRequestReview: false,
  latestReview: undefined,
  reviewHistory: Object.freeze([]),
});
const planningOverview: AgentWorkspaceOverview = Object.freeze({
  projects: [
    {
      project,
      tasks: [
        {
          ...emptyReviewState,
          activeSession: undefined,
          artifacts: [],
          canRetryExecution: false,
          canStartExecution: true,
          latestSession: undefined,
          previousSession: undefined,
          qualityGateRuns: [],
          task: planningTask,
        },
      ],
    },
  ],
});
const failedOverview: AgentWorkspaceOverview = Object.freeze({
  projects: [
    {
      project,
      tasks: [
        {
          ...emptyReviewState,
          activeSession: undefined,
          artifacts: [],
          canRetryExecution: true,
          canStartExecution: false,
          latestSession: failedSession,
          previousSession: undefined,
          qualityGateRuns: [],
          task: runningTask,
        },
      ],
    },
  ],
});
const reviewTask: WorkspaceTaskOverview['task'] = Object.freeze({
  ...runningTask,
  phase: 'REVIEW',
});
const pendingReviewSummary = Object.freeze({
  artifacts: [
    {
      createdAt: 1_800_000_000_010,
      id: 'artifact-summary',
      kind: 'execution-summary' as const,
      phase: 'RUNNING' as const,
      sessionId: 'session-failed',
    },
  ],
  codeState: {
    baseCommitId: 'a'.repeat(40),
    branchName: 'agentterm/task/review',
    changes: {
      committed: ['src/review.ts', 'src/<script>unsafe.ts'],
      conflicted: [],
      staged: [],
      total: 2,
      truncated: false,
      unstaged: [],
      untracked: [],
    },
    fingerprint: 'f'.repeat(64),
    headCommitId: 'b'.repeat(40),
    schemaVersion: 1 as const,
  },
  decidedAt: undefined,
  decisionNote: undefined,
  freshness: 'REVALIDATE_ON_APPROVAL' as const,
  id: 'review-pending',
  qualityGates: [
    {
      association: 'HEAD_MATCH_ONLY' as const,
      baseCommitId: 'a'.repeat(40),
      branchName: 'agentterm/task/review',
      finishedAt: 1_800_000_000_030,
      gateId: 'lint',
      headCommitIdAtStart: 'b'.repeat(40),
      id: 'gate-run-lint',
      kind: 'LINT' as const,
      observedStatus: 'PASSED' as const,
      startedAt: 1_800_000_000_020,
    },
    {
      association: 'STALE' as const,
      baseCommitId: 'a'.repeat(40),
      branchName: 'agentterm/task/review',
      finishedAt: 1_800_000_000_040,
      gateId: 'test',
      headCommitIdAtStart: 'c'.repeat(40),
      id: 'gate-run-test',
      kind: 'TEST' as const,
      observedStatus: 'FAILED' as const,
      startedAt: 1_800_000_000_035,
    },
  ],
  requestedAt: 1_800_000_000_100,
  status: 'PENDING' as const,
  taskId: runningTask.id,
});
const eligibleReviewOverview = Object.freeze({
  projects: [
    {
      project,
      tasks: [
        {
          ...failedOverview.projects[0]!.tasks[0]!,
          canApproveReview: false,
          canRequestChanges: false,
          canRequestReview: true,
          latestReview: undefined,
          reviewHistory: [],
        },
      ],
    },
  ],
}) as AgentWorkspaceOverview;
const pendingReviewOverview = Object.freeze({
  projects: [
    {
      project,
      tasks: [
        {
          activeSession: undefined,
          artifacts: [],
          canApproveReview: true,
          canRequestChanges: true,
          canRequestReview: false,
          canRetryExecution: false,
          canStartExecution: false,
          latestReview: pendingReviewSummary,
          latestSession: failedSession,
          previousSession: undefined,
          qualityGateRuns: [],
          reviewHistory: [
            pendingReviewSummary,
            {
              ...pendingReviewSummary,
              decidedAt: 1_799_999_999_900,
              decisionNote: 'Fix <script>review()</script>.',
              freshness: 'HISTORICAL_SNAPSHOT' as const,
              id: 'review-old',
              requestedAt: 1_799_999_999_800,
              status: 'CHANGES_REQUESTED' as const,
            },
          ],
          task: reviewTask,
        },
      ],
    },
  ],
}) as AgentWorkspaceOverview;

class FakeWorkspaceClient implements AgentWorkspaceClient {
  public readonly attachTerminal = vi.fn(async () => ({
    detach: () => undefined,
    resize: async () => undefined,
    write: async () => undefined,
  }));
  public loadResults: AgentWorkspaceOverview[] = [planningOverview];
  public loadFailure: Error | undefined;
  public startGate: Promise<void> | undefined;
  public readonly startTaskExecution = vi.fn<AgentWorkspaceClient['startTaskExecution']>(
    async () => undefined,
  );
  public readonly retryTaskExecution = vi.fn<AgentWorkspaceClient['retryTaskExecution']>(
    async () => undefined,
  );
  public readonly requestTaskReview = vi.fn<AgentWorkspaceClient['requestTaskReview']>(
    async () => undefined,
  );
  public readonly approveTaskReview = vi.fn<AgentWorkspaceClient['approveTaskReview']>(
    async () => undefined,
  );
  public readonly requestTaskChanges = vi.fn<AgentWorkspaceClient['requestTaskChanges']>(
    async () => undefined,
  );

  public async loadWorkspace(): Promise<AgentWorkspaceOverview> {
    if (this.loadFailure !== undefined) {
      throw this.loadFailure;
    }
    return this.loadResults.shift() ?? failedOverview;
  }

  public async waitForStartGate(): Promise<void> {
    await this.startGate;
  }
}

describe('WorkspaceController', () => {
  it('loads Projects, selects the first Task, and preserves Unicode labels', async () => {
    const client = new FakeWorkspaceClient();
    const observed: WorkspaceSnapshot[] = [];
    const controller = new WorkspaceController(client, (snapshot) => observed.push(snapshot));

    await controller.load();

    expect(observed[0]).toEqual({ kind: 'loading' });
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      selectedTaskId: 'task-1',
    });
    expect(selectedTask(controller.snapshot)?.task.title).toBe('Nối terminal tiếng Việt');
  });

  it('changes the selected Task without loading or starting execution', async () => {
    const secondTask: WorkspaceTaskOverview['task'] = {
      id: 'task-2',
      phase: 'BACKLOG',
      projectId: project.id,
      title: 'Task thứ hai',
    };
    const client = new FakeWorkspaceClient();
    client.loadResults = [
      {
        projects: [
          {
            project,
            tasks: [
              {
                ...emptyReviewState,
                activeSession: undefined,
                artifacts: [],
                canRetryExecution: false,
                canStartExecution: true,
                latestSession: undefined,
                previousSession: undefined,
                qualityGateRuns: [],
                task: planningTask,
              },
              {
                ...emptyReviewState,
                activeSession: undefined,
                artifacts: [],
                canRetryExecution: false,
                canStartExecution: false,
                latestSession: undefined,
                previousSession: undefined,
                qualityGateRuns: [],
                task: secondTask,
              },
            ],
          },
        ],
      },
    ];
    const controller = new WorkspaceController(client);
    await controller.load();

    controller.selectTask('task-2');

    expect(controller.snapshot).toMatchObject({ kind: 'ready', selectedTaskId: 'task-2' });
    expect(client.startTaskExecution).not.toHaveBeenCalled();
  });

  it('starts the selected Task once, reloads the overview, and preserves selection', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [planningOverview, failedOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    await Promise.all([controller.startSelectedTask(), controller.startSelectedTask()]);

    expect(client.startTaskExecution).toHaveBeenCalledOnce();
    expect(client.startTaskExecution).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(controller.snapshot).toMatchObject({
      actionError: undefined,
      kind: 'ready',
      selectedTaskId: 'task-1',
      activeAction: undefined,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({
      latestSession: { status: 'FAILED' },
      task: { phase: 'RUNNING' },
    });
  });

  it('retries a terminal attempt once and selects the newly active Session', async () => {
    const recoveredOverview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...emptyReviewState,
              activeSession: workingSession,
              artifacts: [],
              canRetryExecution: false,
              canStartExecution: false,
              latestSession: workingSession,
              previousSession: failedSession,
              qualityGateRuns: [],
              task: runningTask,
            },
          ],
        },
      ],
    };
    const client = new FakeWorkspaceClient();
    client.loadResults = [failedOverview, recoveredOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    await Promise.all([controller.retrySelectedTask(), controller.retrySelectedTask()]);

    expect(client.retryTaskExecution).toHaveBeenCalledOnce();
    expect(client.retryTaskExecution).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(client.startTaskExecution).not.toHaveBeenCalled();
    expect(controller.snapshot).toMatchObject({
      actionError: undefined,
      selectedTaskId: 'task-1',
      terminalSessionId: workingSession.id,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({
      activeSession: { id: workingSession.id, status: 'WORKING' },
      previousSession: { id: failedSession.id, status: 'FAILED' },
    });
  });

  it('requests Review once and serializes it with execution actions', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [eligibleReviewOverview, pendingReviewOverview];
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    client.requestTaskReview.mockImplementationOnce(() => reviewGate);
    const controller = new WorkspaceController(client);
    await controller.load();

    const first = controller.requestSelectedTaskReview();
    const duplicate = controller.requestSelectedTaskReview();
    const competingRetry = controller.retrySelectedTask();
    expect(controller.snapshot).toMatchObject({
      activeAction: { kind: 'request-review', taskId: runningTask.id },
    });
    releaseReview();
    await Promise.all([first, duplicate, competingRetry]);

    expect(client.requestTaskReview).toHaveBeenCalledOnce();
    expect(client.requestTaskReview).toHaveBeenCalledWith({ taskId: runningTask.id });
    expect(client.retryTaskExecution).not.toHaveBeenCalled();
    expect(controller.snapshot).toMatchObject({
      activeAction: undefined,
      selectedTaskId: runningTask.id,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({
      latestReview: { id: 'review-pending', status: 'PENDING' },
      task: { phase: 'REVIEW' },
    });
  });

  it('approves the exact pending Review once and reloads DONE state', async () => {
    const approvedOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...pendingReviewOverview.projects[0]!.tasks[0]!,
              canApproveReview: false,
              canRequestChanges: false,
              latestReview: {
                ...pendingReviewSummary,
                decidedAt: 1_800_000_000_200,
                freshness: 'HISTORICAL_SNAPSHOT' as const,
                status: 'APPROVED' as const,
              },
              task: { ...reviewTask, phase: 'DONE' as const },
            },
          ],
        },
      ],
    } as AgentWorkspaceOverview;
    const client = new FakeWorkspaceClient();
    client.loadResults = [pendingReviewOverview, approvedOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    await Promise.all([
      controller.approveSelectedTaskReview(),
      controller.approveSelectedTaskReview(),
    ]);

    expect(client.approveTaskReview).toHaveBeenCalledOnce();
    expect(client.approveTaskReview).toHaveBeenCalledWith({
      reviewId: 'review-pending',
      taskId: runningTask.id,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({
      latestReview: { status: 'APPROVED' },
      task: { phase: 'DONE' },
    });
  });

  it('requests changes for the exact pending Review and reloads RUNNING state', async () => {
    const changesOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...eligibleReviewOverview.projects[0]!.tasks[0]!,
              canRequestReview: true,
              latestReview: {
                ...pendingReviewSummary,
                decidedAt: 1_800_000_000_200,
                freshness: 'HISTORICAL_SNAPSHOT' as const,
                status: 'CHANGES_REQUESTED' as const,
              },
              reviewHistory: [],
            },
          ],
        },
      ],
    } as AgentWorkspaceOverview;
    const client = new FakeWorkspaceClient();
    client.loadResults = [pendingReviewOverview, changesOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    await controller.requestSelectedTaskChanges();

    expect(client.requestTaskChanges).toHaveBeenCalledOnce();
    expect(client.requestTaskChanges).toHaveBeenCalledWith({
      reviewId: 'review-pending',
      taskId: runningTask.id,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({ task: { phase: 'RUNNING' } });
  });

  it('shows sanitized load and start errors without leaking native messages', async () => {
    const loadClient = new FakeWorkspaceClient();
    loadClient.loadFailure = new Error('secret path D:\\private\\agentterm.db');
    const loadController = new WorkspaceController(loadClient);
    await loadController.load();

    expect(loadController.snapshot).toEqual({
      kind: 'error',
      message: 'Workspace data could not be loaded.',
    });

    const startClient = new FakeWorkspaceClient();
    startClient.startTaskExecution.mockRejectedValueOnce(new Error('OPENAI_API_KEY=secret'));
    const startController = new WorkspaceController(startClient);
    await startController.load();
    await startController.startSelectedTask();

    expect(startController.snapshot).toMatchObject({
      actionError: 'Task execution could not be started.',
      kind: 'ready',
      selectedTaskId: 'task-1',
    });
    expect(JSON.stringify(startController.snapshot)).not.toContain('OPENAI_API_KEY');

    const retryClient = new FakeWorkspaceClient();
    retryClient.loadResults = [failedOverview];
    retryClient.retryTaskExecution.mockRejectedValueOnce(new Error('D:\\secret\\worktree'));
    const retryController = new WorkspaceController(retryClient);
    await retryController.load();
    await retryController.retrySelectedTask();

    expect(retryController.snapshot).toMatchObject({
      actionError: 'Task execution could not be retried.',
      kind: 'ready',
    });
    expect(JSON.stringify(retryController.snapshot)).not.toContain('secret');
  });

  it('shows differentiated sanitized Review action errors', async () => {
    const requestClient = new FakeWorkspaceClient();
    requestClient.loadResults = [eligibleReviewOverview];
    requestClient.requestTaskReview.mockRejectedValueOnce(new Error('D:\\secret\\review'));
    const requestController = new WorkspaceController(requestClient);
    await requestController.load();
    await requestController.requestSelectedTaskReview();
    expect(requestController.snapshot).toMatchObject({
      actionError: 'Task review could not be requested.',
    });

    const approveClient = new FakeWorkspaceClient();
    approveClient.loadResults = [pendingReviewOverview];
    approveClient.approveTaskReview.mockRejectedValueOnce(new Error('TOKEN=secret'));
    const approveController = new WorkspaceController(approveClient);
    await approveController.load();
    await approveController.approveSelectedTaskReview();
    expect(approveController.snapshot).toMatchObject({
      actionError: 'Task review could not be approved.',
    });

    const changesClient = new FakeWorkspaceClient();
    changesClient.loadResults = [pendingReviewOverview];
    changesClient.requestTaskChanges.mockRejectedValueOnce(new Error('CREDENTIAL=secret'));
    const changesController = new WorkspaceController(changesClient);
    await changesController.load();
    await changesController.requestSelectedTaskChanges();
    expect(changesController.snapshot).toMatchObject({
      actionError: 'Task changes could not be requested.',
    });

    expect(
      JSON.stringify([
        requestController.snapshot,
        approveController.snapshot,
        changesController.snapshot,
      ]),
    ).not.toContain('secret');
  });

  it('does not report a successful execution side effect as failed when only refresh fails', async () => {
    const client = new FakeWorkspaceClient();
    const controller = new WorkspaceController(client);
    await controller.load();
    client.loadFailure = new Error('database became unavailable');

    await controller.startSelectedTask();

    expect(client.startTaskExecution).toHaveBeenCalledOnce();
    expect(controller.snapshot).toMatchObject({
      actionError: 'Task execution started, but workspace status could not be refreshed.',
      kind: 'ready',
      selectedTaskId: 'task-1',
      activeAction: undefined,
    });
  });

  it('does not report a successful Review request as failed when only refresh fails', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [eligibleReviewOverview];
    const controller = new WorkspaceController(client);
    await controller.load();
    client.loadFailure = new Error('database became unavailable');

    await controller.requestSelectedTaskReview();

    expect(client.requestTaskReview).toHaveBeenCalledOnce();
    expect(controller.snapshot).toMatchObject({
      actionError: 'Task review requested, but workspace status could not be refreshed.',
      activeAction: undefined,
      kind: 'ready',
      selectedTaskId: runningTask.id,
    });
  });

  it('keeps the current workspace and terminal selection when a background refresh fails', async () => {
    const client = new FakeWorkspaceClient();
    const controller = new WorkspaceController(client);
    await controller.load();
    client.loadFailure = new Error('transient database failure');

    await controller.refresh();

    expect(controller.snapshot).toMatchObject({
      actionError: 'Workspace status could not be refreshed.',
      kind: 'ready',
      selectedTaskId: 'task-1',
    });
  });

  it('does not steal Task selection when an earlier start finishes after navigation', async () => {
    const secondTask: WorkspaceTaskOverview['task'] = {
      id: 'task-2',
      phase: 'PLANNING',
      projectId: project.id,
      title: 'Task thứ hai',
    };
    const overview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...emptyReviewState,
              activeSession: undefined,
              artifacts: [],
              canRetryExecution: false,
              canStartExecution: true,
              latestSession: undefined,
              previousSession: undefined,
              qualityGateRuns: [],
              task: planningTask,
            },
            {
              ...emptyReviewState,
              activeSession: undefined,
              artifacts: [],
              canRetryExecution: false,
              canStartExecution: true,
              latestSession: undefined,
              previousSession: undefined,
              qualityGateRuns: [],
              task: secondTask,
            },
          ],
        },
      ],
    };
    const client = new FakeWorkspaceClient();
    client.loadResults = [overview, overview];
    let releaseStart!: () => void;
    client.startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    client.startTaskExecution.mockImplementationOnce(() => client.waitForStartGate());
    const controller = new WorkspaceController(client);
    await controller.load();

    const started = controller.startSelectedTask();
    controller.selectTask('task-2');
    releaseStart();
    await started;

    expect(controller.snapshot).toMatchObject({ kind: 'ready', selectedTaskId: 'task-2' });
  });

  it('keeps the displayed terminal session after exit refresh so its buffer is preserved', async () => {
    const activeOverview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...emptyReviewState,
              activeSession: workingSession,
              artifacts: [],
              canRetryExecution: false,
              canStartExecution: false,
              latestSession: workingSession,
              previousSession: undefined,
              qualityGateRuns: [],
              task: runningTask,
            },
          ],
        },
      ],
    };
    const exitedOverview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...emptyReviewState,
              activeSession: undefined,
              artifacts: [],
              canRetryExecution: true,
              canStartExecution: false,
              latestSession: { ...workingSession, endedAt: 1_800_000_000_100, status: 'EXITED' },
              previousSession: undefined,
              qualityGateRuns: [],
              task: runningTask,
            },
          ],
        },
      ],
    };
    const client = new FakeWorkspaceClient();
    client.loadResults = [activeOverview, exitedOverview];
    const controller = new WorkspaceController(client);

    await controller.load();
    expect(controller.snapshot).toMatchObject({ terminalSessionId: 'session-working' });

    await controller.refresh();

    expect(controller.snapshot).toMatchObject({
      selectedTaskId: 'task-1',
      terminalSessionId: 'session-working',
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({
      activeSession: undefined,
      latestSession: { status: 'EXITED' },
    });
  });
});

describe('AgentWorkspaceView', () => {
  it('offers an explicit Start review action only when Application marks RUNNING ready', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          overview: eligibleReviewOverview,
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('Start review');
    expect(markup).toContain('Retry execution');
    expect(markup).not.toContain('Approve and mark done');
  });

  it('renders Review evidence newest-first and explicit user decisions without claiming freshness', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          overview: pendingReviewOverview,
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('Review evidence');
    expect(markup).toContain('2 attempts');
    expect(markup.indexOf('review-pending')).toBeLessThan(markup.indexOf('review-old'));
    expect(markup).toContain('REVALIDATE_ON_APPROVAL');
    expect(markup).toContain('Approval revalidates this exact code snapshot');
    expect(markup).toContain('f'.repeat(64));
    expect(markup).toContain('2 changed paths');
    expect(markup).toContain('1 artifact');
    expect(markup).toContain('2 quality gates');
    expect(markup).toContain('HEAD_MATCH_ONLY');
    expect(markup).toContain('STALE');
    expect(markup).toContain('src/&lt;script&gt;unsafe.ts');
    expect(markup).toContain('Fix &lt;script&gt;review()&lt;/script&gt;.');
    expect(markup).not.toContain('<script>review()</script>');
    expect(markup).not.toContain('worktreePathIdentity');
    expect(markup).not.toContain('D:\\private');
    expect(markup.indexOf('Request changes')).toBeLessThan(markup.indexOf('Approve and mark done'));
    expect(markup).toContain('Task phase</span><strong>REVIEW');
    expect(markup).not.toContain('Task phase</span><strong>DONE');
  });

  it('renders validated artifact history as escaped Unicode text without changing Task state', () => {
    const overview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...emptyReviewState,
              activeSession: workingSession,
              artifacts: [
                {
                  canonicalName: 'running/execution-summary.md',
                  content:
                    '# Execution Summary\n\nĐã lưu an toàn <script>window.pwned = true</script>.',
                  createdAt: 1_800_000_000_002,
                  format: 'markdown',
                  id: 'artifact-summary',
                  kind: 'execution-summary',
                  phase: 'RUNNING',
                  schemaVersion: 1,
                  sessionId: workingSession.id,
                  taskId: runningTask.id,
                  validation: 'VALID',
                },
              ],
              canRetryExecution: false,
              canStartExecution: false,
              latestSession: workingSession,
              previousSession: undefined,
              qualityGateRuns: [],
              task: runningTask,
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          kind: 'ready',
          overview,
          selectedTaskId: runningTask.id,
          activeAction: undefined,
          terminalSessionId: workingSession.id,
        },
      }),
    );

    expect(markup).toContain('Execution artifacts');
    expect(markup).toContain('execution-summary');
    expect(markup).toContain('session-working');
    expect(markup).toContain('Đã lưu an toàn');
    expect(markup).toContain('&lt;script&gt;window.pwned = true&lt;/script&gt;');
    expect(markup).not.toContain('<script>window.pwned');
    expect(markup).toContain('Task phase</span><strong>RUNNING');
  });

  it('renders TaskPhase and AgentSessionStatus as separate states when a Session failed', () => {
    const client = new FakeWorkspaceClient();
    const snapshot: WorkspaceSnapshot = {
      actionError: undefined,
      kind: 'ready',
      overview: failedOverview,
      selectedTaskId: 'task-1',
      activeAction: undefined,
      terminalSessionId: undefined,
    };

    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client,
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot,
      }),
    );

    expect(markup).toContain('Task phase');
    expect(markup).toContain('RUNNING');
    expect(markup).toContain('Latest session');
    expect(markup).toContain('FAILED');
    expect(markup).toContain('interrupted when AgentTerm restarted');
    expect(markup).toContain('Task phase remains RUNNING');
    expect(markup).toContain('Retry execution');
    expect(markup).not.toContain('Task phase</span><strong>DONE');
    expect(markup).toContain('Nối terminal tiếng Việt');
  });

  it('shows the prior failed attempt separately from the newly active Session', () => {
    const overview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [
            {
              ...emptyReviewState,
              activeSession: workingSession,
              artifacts: [],
              canRetryExecution: false,
              canStartExecution: false,
              latestSession: workingSession,
              previousSession: failedSession,
              qualityGateRuns: [],
              task: runningTask,
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          kind: 'ready',
          overview,
          selectedTaskId: runningTask.id,
          activeAction: undefined,
          terminalSessionId: workingSession.id,
        },
      }),
    );

    expect(markup).toContain('Previous session');
    expect(markup).toContain('FAILED · session-failed');
    expect(markup).toContain('codex · session-working');
  });

  it('renders immutable Quality Gate history newest-first without treating it as Task completion', () => {
    const failedTask = failedOverview.projects[0]!.tasks[0]!;
    const overview: AgentWorkspaceOverview = {
      projects: [
        {
          project,
          tasks: [{ ...failedTask, qualityGateRuns: [passedLintRun, failedTestRun] }],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          kind: 'ready',
          overview,
          selectedTaskId: runningTask.id,
          activeAction: undefined,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('Recorded evidence');
    expect(markup).toContain('Quality gates');
    expect(markup).toContain('2 runs');
    expect(markup.indexOf('gate-run-test')).toBeLessThan(markup.indexOf('gate-run-lint'));
    expect(markup).toContain('FAILED');
    expect(markup).toContain('Exit 1');
    expect(markup).toContain('1.3 s');
    expect(markup).toContain('output truncated');
    expect(markup).toContain(
      'Ki\u1ec3m th\u1eed th\u1ea5t b\u1ea1i: &lt;script&gt;secret()&lt;/script&gt;',
    );
    expect(markup).not.toContain('<script>secret()</script>');
    expect(markup).toContain('Task phase</span><strong>RUNNING');
    expect(markup).not.toContain('Task phase</span><strong>DONE');
    expect(markup).not.toContain('output-test');
    expect(markup).not.toContain('D:\\worktrees');
  });

  it('states clearly when AgentTerm has not recorded Quality Gate evidence', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          kind: 'ready',
          overview: planningOverview,
          selectedTaskId: planningTask.id,
          activeAction: undefined,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('No AgentTerm-recorded gate evidence for this Task yet.');
  });

  it('renders loading, empty, and recoverable error states', () => {
    const client = new FakeWorkspaceClient();
    const common = {
      client,
      onApproveReview: () => undefined,
      onRefresh: () => undefined,
      onRequestChanges: () => undefined,
      onRequestReview: () => undefined,
      onRetry: () => undefined,
      onRetryTask: () => undefined,
      onSelectTask: () => undefined,
      onStartTask: () => undefined,
    };

    const loading = renderToStaticMarkup(
      createElement(AgentWorkspaceView, { ...common, snapshot: { kind: 'loading' } }),
    );
    const empty = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        ...common,
        snapshot: {
          actionError: undefined,
          kind: 'ready',
          overview: { projects: [] },
          selectedTaskId: undefined,
          activeAction: undefined,
          terminalSessionId: undefined,
        },
      }),
    );
    const error = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        ...common,
        snapshot: { kind: 'error', message: 'Workspace data could not be loaded.' },
      }),
    );

    expect(loading).toContain('Loading workspace');
    expect(empty).toContain('No Projects yet');
    expect(error).toContain('Workspace data could not be loaded.');
    expect(error).toContain('Retry');
  });
});

function selectedTask(snapshot: WorkspaceSnapshot): WorkspaceTaskOverview | undefined {
  if (snapshot.kind !== 'ready') {
    return undefined;
  }
  return snapshot.overview.projects
    .flatMap((currentProject) => currentProject.tasks)
    .find((task) => task.task.id === snapshot.selectedTaskId);
}
