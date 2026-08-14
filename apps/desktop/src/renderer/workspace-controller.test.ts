import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentWorkspaceOverview,
  ApplicationSettingsView,
  QualityGateSummary,
  TaskChangeSet,
  TaskPullRequestState,
  WorkspaceTaskOverview,
} from '@agentterm/application';

import {
  AgentWorkspaceView as AgentWorkspaceViewComponent,
  type AgentWorkspaceViewProps,
} from './agent-workspace';
import {
  WorkspaceController,
  type AgentWorkspaceClient,
  type WorkspaceSnapshot,
} from './workspace-controller';
import {
  createWorkspaceLayout,
  openWorkspaceTab,
  splitWorkspaceTerminal,
} from './workspace-layout';

type TestWorkspaceViewProps = Omit<
  AgentWorkspaceViewProps,
  | 'onAcceptPlan'
  | 'onBeginPlanning'
  | 'onCloseWorkspacePane'
  | 'onCloseWorkspaceTab'
  | 'onCreatePullRequest'
  | 'onCreateTask'
  | 'onCycleWorkspacePane'
  | 'onCycleWorkspaceTab'
  | 'onPushTaskBranch'
  | 'onOpenProject'
  | 'onRefreshPullRequest'
  | 'onRunQualityGate'
  | 'onSelectWorkspacePane'
  | 'onSelectWorkspaceTab'
  | 'onSelectTaskChange'
  | 'onSplitTerminal'
  | 'onStartPlanning'
> &
  Partial<
    Pick<
      AgentWorkspaceViewProps,
      | 'onAcceptPlan'
      | 'onBeginPlanning'
      | 'onCloseWorkspacePane'
      | 'onCloseWorkspaceTab'
      | 'onCreatePullRequest'
      | 'onCreateTask'
      | 'onCycleWorkspacePane'
      | 'onCycleWorkspaceTab'
      | 'onPushTaskBranch'
      | 'onOpenProject'
      | 'onRefreshPullRequest'
      | 'onRunQualityGate'
      | 'onSelectWorkspacePane'
      | 'onSelectWorkspaceTab'
      | 'onSelectTaskChange'
      | 'onSplitTerminal'
      | 'onStartPlanning'
    >
  >;

function AgentWorkspaceView(props: TestWorkspaceViewProps) {
  return createElement(AgentWorkspaceViewComponent, {
    onAcceptPlan: () => undefined,
    onBeginPlanning: () => undefined,
    onCloseWorkspacePane: () => undefined,
    onCloseWorkspaceTab: () => undefined,
    onCreatePullRequest: () => undefined,
    onCreateTask: async () => true,
    onCycleWorkspacePane: () => undefined,
    onCycleWorkspaceTab: () => undefined,
    onPushTaskBranch: () => undefined,
    onOpenProject: () => undefined,
    onRefreshPullRequest: () => undefined,
    onRunQualityGate: () => undefined,
    onSelectWorkspacePane: () => undefined,
    onSelectWorkspaceTab: () => undefined,
    onSelectTaskChange: () => undefined,
    onSplitTerminal: () => undefined,
    onStartPlanning: () => undefined,
    ...props,
  });
}

const project = Object.freeze({
  id: 'project-1',
  name: 'Dự án AgentTerm',
});
const planningTask: WorkspaceTaskOverview['task'] = Object.freeze({
  brief: 'Nối terminal an toàn và giữ nguyên lịch sử Session.',
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
const defaultWorkspaceLayout = createWorkspaceLayout({
  sessionId: workingSession.id,
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
  blocked: false,
  canAcceptPlan: false,
  canApproveReview: false,
  canBeginPlanning: false,
  canRequestChanges: false,
  canRequestReview: false,
  canRevisePlan: false,
  canRunQualityGate: false,
  canStartPlanning: false,
  dependencies: Object.freeze([]),
  latestPlan: undefined,
  latestReview: undefined,
  reviewHistory: Object.freeze([]),
});
const availableAgents = Object.freeze([
  Object.freeze({
    capabilities: Object.freeze(['SESSION_RESUME'] as const),
    displayName: 'Codex',
    id: 'codex',
    kind: 'available' as const,
  }),
  Object.freeze({
    displayName: 'Future Agent',
    id: 'future-agent',
    kind: 'unavailable' as const,
    reason: 'EXECUTABLE_NOT_FOUND' as const,
  }),
]);
function settings(
  overrides: {
    readonly agentExecutables?: ApplicationSettingsView['settings']['agentExecutables'];
    readonly defaultAgentId?: string;
    readonly revision?: number;
    readonly terminalFontSize?: number;
  } = {},
): ApplicationSettingsView['settings'] {
  return Object.freeze({
    agentExecutables: overrides.agentExecutables ?? Object.freeze([]),
    defaultAgentId: overrides.defaultAgentId ?? 'codex',
    revision: overrides.revision ?? 0,
    schemaVersion: 1,
    terminalFontSize: overrides.terminalFontSize ?? 14,
  });
}
const defaultSettingsView: ApplicationSettingsView = Object.freeze({
  agents: Object.freeze([
    Object.freeze({
      capabilities: Object.freeze(['SESSION_RESUME'] as const),
      configuredExecutablePath: undefined,
      detectedExecutablePath: 'C:\\detected\\codex.exe',
      displayName: 'Codex',
      id: 'codex',
      kind: 'available' as const,
      version: 'codex 1.2.3',
    }),
    Object.freeze({
      configuredExecutablePath: undefined,
      displayName: 'Claude',
      id: 'claude',
      kind: 'unavailable' as const,
      reason: 'EXECUTABLE_NOT_FOUND' as const,
    }),
  ]),
  settings: settings(),
});
const pullRequestReady: TaskPullRequestState = Object.freeze({
  branch: Object.freeze({
    baseBranch: 'main',
    githubAuthenticationAvailable: true,
    githubCliAvailable: true,
    headBranch: 'agentterm/task/github-pr',
    headCommitId: 'b'.repeat(40),
    kind: 'ready' as const,
    provider: 'github' as const,
    pullRequest: undefined,
    remoteHeadCommitId: undefined,
    remoteName: 'origin',
    repositoryName: 'AgentTerm',
    repositoryOwner: 'agentterm',
  }),
  canCreatePullRequest: false,
  canPush: true,
  pullRequest: undefined,
});
const openPullRequest = Object.freeze({
  baseBranch: 'main',
  checks: Object.freeze({
    failureCount: 0,
    pendingCount: 0,
    state: 'SUCCESS' as const,
    successCount: 3,
    totalCount: 3,
  }),
  createdAt: 1_800_000_000_000,
  draft: false,
  headBranch: 'agentterm/task/github-pr',
  headCommitId: 'b'.repeat(40),
  lastSyncedAt: 1_800_000_000_200,
  number: 42,
  provider: 'github' as const,
  repositoryName: 'AgentTerm',
  repositoryOwner: 'agentterm',
  reviewState: 'APPROVED' as const,
  status: 'OPEN' as const,
  taskId: runningTask.id,
  title: 'Explicit PR',
  updatedAt: 1_800_000_000_100,
  url: 'https://github.com/agentterm/AgentTerm/pull/42',
});
const planningOverview: AgentWorkspaceOverview = Object.freeze({
  agents: availableAgents,
  projects: [
    {
      project,
      tasks: [
        {
          ...emptyReviewState,
          activeSession: undefined,
          artifacts: [],
          canRetryExecution: false,
          canStartExecution: false,
          canStartPlanning: true,
          latestSession: undefined,
          previousSession: undefined,
          qualityGateRuns: [],
          task: planningTask,
        },
      ],
    },
  ],
});
const emptyProjectOverview: AgentWorkspaceOverview = Object.freeze({
  agents: availableAgents,
  projects: Object.freeze([{ project, tasks: Object.freeze([]) }]),
});
const backlogOverview: AgentWorkspaceOverview = Object.freeze({
  agents: availableAgents,
  projects: Object.freeze([
    {
      project,
      tasks: Object.freeze([
        {
          ...emptyReviewState,
          activeSession: undefined,
          artifacts: Object.freeze([]),
          canBeginPlanning: true,
          canRetryExecution: false,
          canStartExecution: false,
          latestSession: undefined,
          previousSession: undefined,
          qualityGateRuns: Object.freeze([]),
          task: Object.freeze({ ...planningTask, phase: 'BACKLOG' as const }),
        },
      ]),
    },
  ]),
});
const runningStartOverview: AgentWorkspaceOverview = Object.freeze({
  agents: availableAgents,
  projects: [
    {
      project,
      tasks: [
        {
          ...emptyReviewState,
          activeSession: undefined,
          artifacts: [],
          canRetryExecution: false,
          canRunQualityGate: true,
          canStartExecution: true,
          latestSession: undefined,
          previousSession: undefined,
          qualityGateRuns: [],
          task: runningTask,
        },
      ],
    },
  ],
});
const failedOverview: AgentWorkspaceOverview = Object.freeze({
  agents: availableAgents,
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
  agents: availableAgents,
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
  agents: availableAgents,
  projects: [
    {
      project,
      tasks: [
        {
          ...emptyReviewState,
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
  public readonly beginTaskPlanning = vi.fn(async () => undefined);
  public readonly createTask = vi.fn(async () => ({ taskId: planningTask.id }));
  public readonly openProject = vi.fn(async () => 'OPENED' as const);
  public loadResults: AgentWorkspaceOverview[] = [planningOverview];
  public loadFailure: Error | undefined;
  public startGate: Promise<void> | undefined;
  public changeSet: TaskChangeSet = Object.freeze({
    files: Object.freeze([]),
    totalFiles: 0,
    truncated: false,
  });
  public readonly listTaskChanges = vi.fn(async () => Promise.resolve(this.changeSet));
  public readonly getTaskFileDiff = vi.fn(
    async (input: {
      readonly area: 'COMMITTED' | 'CONFLICTED' | 'STAGED' | 'UNSTAGED' | 'UNTRACKED';
      readonly path: string;
      readonly previousPath?: string;
      readonly taskId: string;
    }) =>
      Promise.resolve({
        additions: 1,
        area: input.area,
        binary: false,
        deletions: 1,
        kind: 'MODIFIED' as const,
        patch: Object.freeze({ text: '-before\n+after\n', truncated: false as const }),
        path: input.path,
        ...(input.previousPath === undefined ? {} : { previousPath: input.previousPath }),
      }),
  );
  public pullRequestState: TaskPullRequestState = pullRequestReady;
  public readonly inspectTaskPullRequest = vi.fn(async () => this.pullRequestState);
  public readonly pushTaskBranch = vi.fn(async () => undefined);
  public readonly createTaskPullRequest = vi.fn(async () => undefined);
  public readonly refreshTaskPullRequest = vi.fn(async () => undefined);
  public readonly gateSummaries: readonly QualityGateSummary[] = Object.freeze([
    Object.freeze({ id: 'lint', kind: 'LINT' as const }),
  ]);
  public readonly listQualityGates = vi.fn(async () => this.gateSummaries);
  public readonly runQualityGate = vi.fn(async () => undefined);
  public readonly startTaskExecution = vi.fn<AgentWorkspaceClient['startTaskExecution']>(
    async () => undefined,
  );
  public readonly startTaskPlanning = vi.fn<AgentWorkspaceClient['startTaskPlanning']>(
    async () => undefined,
  );
  public readonly acceptTaskPlan = vi.fn<AgentWorkspaceClient['acceptTaskPlan']>(
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
  public settingsView: ApplicationSettingsView = defaultSettingsView;
  public readonly loadSettings = vi.fn(async () => this.settingsView);
  public readonly updateSettings = vi.fn<AgentWorkspaceClient['updateSettings']>(async (input) => {
    this.settingsView = Object.freeze({
      ...this.settingsView,
      settings: settings({
        agentExecutables: input.agentExecutables,
        defaultAgentId: input.defaultAgentId,
        revision: input.expectedRevision + 1,
        terminalFontSize: input.terminalFontSize,
      }),
    });
    return this.settingsView;
  });

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
  it('opens a Project through the safe bridge and reloads the workspace after selection', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [
      Object.freeze({ agents: availableAgents, projects: [] }),
      emptyProjectOverview,
    ];
    const controller = new WorkspaceController(client);
    await controller.load();

    await expect(controller.openProject()).resolves.toBe(true);

    expect(client.openProject).toHaveBeenCalledWith();
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      onboardingBusy: false,
      overview: { projects: [{ project: { id: project.id } }] },
    });
  });

  it('creates a BACKLOG Task and selects it without exposing repository paths', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [emptyProjectOverview, backlogOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    await expect(
      controller.createTask({
        brief: 'Chạy agent trong đúng Worktree và giữ lịch sử.',
        projectId: project.id,
        title: 'Kiểm thử agent thật',
      }),
    ).resolves.toBe(true);

    expect(client.createTask).toHaveBeenCalledWith({
      brief: 'Chạy agent trong đúng Worktree và giữ lịch sử.',
      projectId: project.id,
      title: 'Kiểm thử agent thật',
    });
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      selectedTaskId: planningTask.id,
    });
  });

  it('requires an explicit user action before a BACKLOG Task enters PLANNING', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [backlogOverview, planningOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    expect(client.beginTaskPlanning).not.toHaveBeenCalled();
    await controller.beginSelectedTaskPlanning();

    expect(client.beginTaskPlanning).toHaveBeenCalledWith({ taskId: planningTask.id });
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      overview: { projects: [{ tasks: [{ task: { phase: 'PLANNING' } }] }] },
    });
  });

  it('uses the persisted default agent when that agent is currently available', async () => {
    const claude = Object.freeze({
      capabilities: Object.freeze(['SESSION_RESUME'] as const),
      displayName: 'Claude',
      id: 'claude',
      kind: 'available' as const,
    });
    const client = new FakeWorkspaceClient();
    client.loadResults = [
      Object.freeze({ ...planningOverview, agents: Object.freeze([availableAgents[0]!, claude]) }),
    ];
    client.settingsView = Object.freeze({
      agents: Object.freeze([
        defaultSettingsView.agents[0]!,
        Object.freeze({
          capabilities: Object.freeze(['SESSION_RESUME'] as const),
          configuredExecutablePath: 'C:\\Tools\\claude.exe',
          detectedExecutablePath: 'C:\\Tools\\claude.exe',
          displayName: 'Claude',
          id: 'claude',
          kind: 'available' as const,
          version: '2.0.0',
        }),
      ]),
      settings: settings({ defaultAgentId: 'claude' }),
    });
    const controller = new WorkspaceController(client);

    await controller.load();

    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      selectedAgentId: 'claude',
      settings: { settings: { defaultAgentId: 'claude' } },
    });
  });

  it('updates settings without attaching, detaching, or starting a Session', async () => {
    const client = new FakeWorkspaceClient();
    const controller = new WorkspaceController(client);
    await controller.load();

    await controller.saveSettings({
      agentExecutables: [{ agentId: 'codex', executablePath: 'C:\\Tools\\codex.exe' }],
      defaultAgentId: 'codex',
      expectedRevision: 0,
      terminalFontSize: 18,
    });

    expect(client.updateSettings).toHaveBeenCalledWith({
      agentExecutables: [{ agentId: 'codex', executablePath: 'C:\\Tools\\codex.exe' }],
      defaultAgentId: 'codex',
      expectedRevision: 0,
      terminalFontSize: 18,
    });
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      settings: { settings: { revision: 1, terminalFontSize: 18 } },
      settingsError: undefined,
      settingsSaving: false,
    });
    expect(client.attachTerminal).not.toHaveBeenCalled();
    expect(client.startTaskExecution).not.toHaveBeenCalled();
  });

  it('sanitizes invalid configuration errors and preserves the current settings view', async () => {
    const client = new FakeWorkspaceClient();
    client.updateSettings.mockRejectedValueOnce(
      new Error('C:\\private\\secret-token\\missing-agent.exe'),
    );
    const controller = new WorkspaceController(client);
    await controller.load();

    await controller.saveSettings({
      agentExecutables: [
        { agentId: 'codex', executablePath: 'C:\\private\\secret-token\\missing-agent.exe' },
      ],
      defaultAgentId: 'codex',
      expectedRevision: 0,
      terminalFontSize: 14,
    });

    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      settings: { settings: { revision: 0 } },
      settingsError: 'Settings could not be saved. Check the agent configuration.',
      settingsSaving: false,
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain('secret-token');
  });

  it('loads Projects, selects the first Task, and preserves Unicode labels', async () => {
    const client = new FakeWorkspaceClient();
    const observed: WorkspaceSnapshot[] = [];
    const controller = new WorkspaceController(client, (snapshot) => observed.push(snapshot));

    await controller.load();

    expect(observed[0]).toEqual({ kind: 'loading' });
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      selectedAgentId: 'codex',
      selectedTaskId: 'task-1',
    });
    expect(selectedTask(controller.snapshot)?.task.title).toBe('Nối terminal tiếng Việt');
  });

  it('opens, switches, cycles, and closes Task workspace tabs without losing their Sessions', async () => {
    const secondTask = Object.freeze({
      ...runningTask,
      id: 'task-2',
      title: 'Second live Task',
    });
    const secondSession = Object.freeze({
      ...workingSession,
      id: 'session-2',
      taskId: secondTask.id,
    });
    const overview: AgentWorkspaceOverview = Object.freeze({
      agents: availableAgents,
      projects: [
        {
          project,
          tasks: [
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              activeSession: workingSession,
              latestSession: workingSession,
            },
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              activeSession: secondSession,
              latestSession: secondSession,
              task: secondTask,
            },
          ],
        },
      ],
    });
    const client = new FakeWorkspaceClient();
    client.loadResults = [overview];
    const controller = new WorkspaceController(client);
    await controller.load();

    controller.selectTask('task-2');
    expect(controller.snapshot).toMatchObject({
      layout: {
        activeTabId: 'task:task-2',
        tabs: [
          { panes: [{ sessionId: 'session-working' }], taskId: 'task-1' },
          { panes: [{ sessionId: 'session-2' }], taskId: 'task-2' },
        ],
      },
      selectedTaskId: 'task-2',
      terminalSessionId: 'session-2',
    });

    controller.selectWorkspaceTab('task:task-1');
    expect(controller.snapshot).toMatchObject({ selectedTaskId: 'task-1' });
    controller.cycleWorkspaceTab(1);
    expect(controller.snapshot).toMatchObject({ selectedTaskId: 'task-2' });
    controller.closeWorkspaceTab('task:task-2');
    expect(controller.snapshot).toMatchObject({
      layout: { activeTabId: 'task:task-1', tabs: [{ taskId: 'task-1' }] },
      selectedTaskId: 'task-1',
      terminalSessionId: 'session-working',
    });
  });

  it('splits, focuses, and closes terminal panes using only distinct active Sessions', async () => {
    const secondTask = Object.freeze({ ...runningTask, id: 'task-2', title: 'Second live Task' });
    const secondSession = Object.freeze({ ...workingSession, id: 'session-2', taskId: 'task-2' });
    const overview: AgentWorkspaceOverview = Object.freeze({
      agents: availableAgents,
      projects: [
        {
          project,
          tasks: [
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              activeSession: workingSession,
              latestSession: workingSession,
            },
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              activeSession: secondSession,
              latestSession: secondSession,
              task: secondTask,
            },
          ],
        },
      ],
    });
    const client = new FakeWorkspaceClient();
    client.loadResults = [overview];
    const controller = new WorkspaceController(client);
    await controller.load();

    controller.splitSelectedTerminal('session-2');
    expect(controller.snapshot).toMatchObject({
      layout: {
        tabs: [
          {
            panes: [{ sessionId: 'session-working' }, { sessionId: 'session-2' }],
          },
        ],
      },
      terminalSessionId: 'session-2',
    });
    controller.cycleWorkspacePane(-1);
    expect(controller.snapshot).toMatchObject({ terminalSessionId: 'session-working' });
    const splitPane =
      controller.snapshot.kind === 'ready' ? controller.snapshot.layout.tabs[0]!.panes[1]! : null;
    if (splitPane === null) throw new Error('Expected split pane.');
    controller.closeWorkspacePane(splitPane.id);
    expect(controller.snapshot).toMatchObject({
      layout: { tabs: [{ panes: [{ sessionId: 'session-working' }] }] },
      terminalSessionId: 'session-working',
    });
    expect(client.attachTerminal).not.toHaveBeenCalled();
  });

  it('lists safe Quality Gates and runs one for the selected eligible Task', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [runningStartOverview, runningStartOverview];
    const controller = new WorkspaceController(client);

    await controller.load();
    await controller.runSelectedQualityGate('lint');

    expect(client.listQualityGates).toHaveBeenCalledTimes(2);
    expect(controller.snapshot).toMatchObject({ qualityGates: [{ id: 'lint', kind: 'LINT' }] });
    expect(client.runQualityGate).toHaveBeenCalledWith({ gateId: 'lint', taskId: runningTask.id });
  });

  it('pushes, creates, and refreshes a Pull Request only through explicit selected-Task actions', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [runningStartOverview, runningStartOverview, runningStartOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    expect(client.inspectTaskPullRequest).toHaveBeenCalledWith({ taskId: runningTask.id });
    await controller.pushSelectedTaskBranch();
    expect(client.pushTaskBranch).toHaveBeenCalledWith({ taskId: runningTask.id });

    const branch = pullRequestReady.branch;
    if (branch.kind !== 'ready') throw new Error('Expected ready Pull Request fixture.');
    client.pullRequestState = Object.freeze({
      ...pullRequestReady,
      branch: Object.freeze({ ...branch, remoteHeadCommitId: branch.headCommitId }),
      canCreatePullRequest: true,
      canPush: false,
      pullRequest: openPullRequest,
    });
    await controller.refresh();
    await controller.createSelectedTaskPullRequest();

    expect(client.createTaskPullRequest).toHaveBeenCalledWith({ taskId: runningTask.id });
    await controller.refreshSelectedTaskPullRequest();
    expect(client.refreshTaskPullRequest).toHaveBeenCalledWith({
      pullRequestNumber: openPullRequest.number,
      repositoryName: openPullRequest.repositoryName,
      repositoryOwner: openPullRequest.repositoryOwner,
      taskId: runningTask.id,
    });
    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      pullRequestInspection: {
        kind: 'ready',
        result: { pullRequest: openPullRequest },
      },
    });
  });

  it('keeps Pull Request inspection and action failures sanitized', async () => {
    const inspectClient = new FakeWorkspaceClient();
    inspectClient.inspectTaskPullRequest.mockRejectedValueOnce(new Error('TOKEN=secret'));
    const inspectController = new WorkspaceController(inspectClient);
    await inspectController.load();
    expect(inspectController.snapshot).toMatchObject({
      kind: 'ready',
      pullRequestInspection: {
        kind: 'error',
        message: 'Pull Request status could not be loaded.',
      },
    });

    const pushClient = new FakeWorkspaceClient();
    pushClient.loadResults = [runningStartOverview];
    pushClient.pushTaskBranch.mockRejectedValueOnce(new Error('credential helper secret'));
    const pushController = new WorkspaceController(pushClient);
    await pushController.load();
    await pushController.pushSelectedTaskBranch();
    expect(pushController.snapshot).toMatchObject({
      actionError: 'Task branch could not be pushed.',
      kind: 'ready',
    });

    const refreshClient = new FakeWorkspaceClient();
    refreshClient.pullRequestState = Object.freeze({
      ...pullRequestReady,
      pullRequest: openPullRequest,
    });
    refreshClient.refreshTaskPullRequest.mockRejectedValueOnce(new Error('GH_TOKEN=secret'));
    const refreshController = new WorkspaceController(refreshClient);
    await refreshController.load();
    await refreshController.refreshSelectedTaskPullRequest();
    expect(refreshController.snapshot).toMatchObject({
      actionError: 'Pull Request status could not be refreshed from GitHub.',
      kind: 'ready',
      pullRequestInspection: { kind: 'ready', result: { pullRequest: openPullRequest } },
    });
  });

  it('loads a bounded change list for the selected Task and fetches only the chosen patch', async () => {
    const client = new FakeWorkspaceClient();
    const modified = Object.freeze({
      area: 'UNSTAGED' as const,
      kind: 'MODIFIED' as const,
      path: 'src/workspace.ts',
    });
    client.changeSet = Object.freeze({
      files: Object.freeze([modified]),
      totalFiles: 1,
      truncated: false,
    });
    const controller = new WorkspaceController(client);

    await controller.load();

    expect(client.listTaskChanges).toHaveBeenCalledWith({ taskId: 'task-1' });
    expect(client.getTaskFileDiff).not.toHaveBeenCalled();
    expect(controller.snapshot).toMatchObject({
      changeInspection: { kind: 'ready', result: { totalFiles: 1 }, taskId: 'task-1' },
      kind: 'ready',
    });

    await controller.selectTaskChange(modified);

    expect(client.getTaskFileDiff).toHaveBeenCalledWith({
      area: 'UNSTAGED',
      path: 'src/workspace.ts',
      taskId: 'task-1',
    });
    expect(controller.snapshot).toMatchObject({
      changeInspection: {
        kind: 'ready',
        selectedDiff: { patch: { text: '-before\n+after\n' }, path: 'src/workspace.ts' },
      },
    });
  });

  it('keeps workspace usable and sanitizes change inspection failures', async () => {
    const client = new FakeWorkspaceClient();
    client.listTaskChanges.mockRejectedValueOnce(new Error('D:\\secret\\repository'));
    const controller = new WorkspaceController(client);

    await controller.load();

    expect(controller.snapshot).toMatchObject({
      changeInspection: {
        kind: 'error',
        message: 'Task changes could not be loaded.',
        taskId: 'task-1',
      },
      kind: 'ready',
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain('secret');
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
        agents: availableAgents,
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

  it('preserves an explicitly selected available agent across workspace refreshes', async () => {
    const alternateAgent = Object.freeze({
      capabilities: Object.freeze([]),
      displayName: 'Local Agent',
      id: 'local-agent',
      kind: 'available' as const,
    });
    const overview = Object.freeze({
      ...planningOverview,
      agents: Object.freeze([...availableAgents, alternateAgent]),
    });
    const client = new FakeWorkspaceClient();
    client.loadResults = [overview, overview];
    const controller = new WorkspaceController(client);
    await controller.load();

    controller.selectAgent('local-agent');
    await controller.refresh();
    controller.selectAgent('future-agent');

    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      selectedAgentId: 'local-agent',
    });
  });

  it('does not start a fresh session when no configured agent is available', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [{ ...planningOverview, agents: [availableAgents[1]!] }];
    const controller = new WorkspaceController(client);
    await controller.load();

    await controller.startSelectedTask();

    expect(controller.snapshot).toMatchObject({
      kind: 'ready',
      selectedAgentId: undefined,
      selectedTaskId: planningTask.id,
    });
    expect(client.startTaskExecution).not.toHaveBeenCalled();
  });

  it('starts planning with the selected Agent without dispatching execution', async () => {
    const client = new FakeWorkspaceClient();
    client.loadResults = [planningOverview, failedOverview];
    const controller = new WorkspaceController(client);
    await controller.load();

    await Promise.all([controller.startSelectedPlanning(), controller.startSelectedPlanning()]);

    expect(client.startTaskPlanning).toHaveBeenCalledOnce();
    expect(client.startTaskPlanning).toHaveBeenCalledWith({ agentId: 'codex', taskId: 'task-1' });
    expect(client.startTaskExecution).not.toHaveBeenCalled();
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

  it('accepts the exact latest Plan and reloads the RUNNING Task', async () => {
    const plan = Object.freeze({
      canonicalName: 'planning/plan.md' as const,
      content: '# Plan\n\nImplement after explicit acceptance.',
      createdAt: 1_800_000_000_100,
      format: 'markdown' as const,
      id: 'plan-latest',
      kind: 'plan' as const,
      phase: 'PLANNING' as const,
      schemaVersion: 1 as const,
      sessionId: failedSession.id,
      taskId: planningTask.id,
      validation: 'VALID' as const,
    });
    const ready = {
      ...planningOverview,
      projects: [
        {
          project,
          tasks: [
            {
              ...planningOverview.projects[0]!.tasks[0]!,
              artifacts: [plan],
              canAcceptPlan: true,
              canRevisePlan: true,
              canStartPlanning: false,
              latestPlan: plan,
              latestSession: failedSession,
            },
          ],
        },
      ],
    } satisfies AgentWorkspaceOverview;
    const running = {
      ...ready,
      projects: [
        {
          project,
          tasks: [
            {
              ...ready.projects[0]!.tasks[0]!,
              canAcceptPlan: false,
              canRetryExecution: true,
              canRevisePlan: false,
              task: runningTask,
            },
          ],
        },
      ],
    } satisfies AgentWorkspaceOverview;
    const client = new FakeWorkspaceClient();
    client.loadResults = [ready, running];
    const controller = new WorkspaceController(client);
    await controller.load();

    await controller.acceptSelectedPlan();

    expect(client.acceptTaskPlan).toHaveBeenCalledWith({
      planId: plan.id,
      taskId: planningTask.id,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({ task: { phase: 'RUNNING' } });
  });

  it('retries a terminal attempt once and selects the newly active Session', async () => {
    const alternateAgent = Object.freeze({
      capabilities: Object.freeze([]),
      displayName: 'Local Agent',
      id: 'local-agent',
      kind: 'available' as const,
    });
    const recoveredOverview: AgentWorkspaceOverview = {
      agents: [...availableAgents, alternateAgent],
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
    client.loadResults = [
      { ...failedOverview, agents: [...availableAgents, alternateAgent] },
      recoveredOverview,
    ];
    const controller = new WorkspaceController(client);
    await controller.load();
    controller.selectAgent('local-agent');

    await Promise.all([controller.retrySelectedTask(), controller.retrySelectedTask()]);

    expect(client.retryTaskExecution).toHaveBeenCalledOnce();
    expect(client.retryTaskExecution).toHaveBeenCalledWith({
      agentId: 'local-agent',
      taskId: 'task-1',
    });
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
      agents: availableAgents,
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
      agents: availableAgents,
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
    startClient.loadResults = [runningStartOverview];
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
    client.loadResults = [runningStartOverview];
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
      agents: availableAgents,
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
      agents: availableAgents,
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
      agents: availableAgents,
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

describe('command palette discoverability', () => {
  it('renders the palette shortcut and keyboard-focus landmarks without hiding terminal controls', () => {
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
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
          changeInspection: { kind: 'idle' },
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview: runningStartOverview,
          pullRequestInspection: { kind: 'idle' },
          qualityGates: [{ id: 'lint', kind: 'LINT' }],
          selectedAgentId: 'codex',
          selectedTaskId: runningTask.id,
          terminalSessionId: workingSession.id,
        },
      }),
    );

    expect(markup).toContain('aria-label="Open command palette"');
    expect(markup).toContain('Ctrl+Shift+P');
    expect(markup).toContain('id="workspace-sidebar"');
    expect(markup).toContain('id="workspace-main"');
    expect(markup).toContain('data-active-terminal-pane="true"');
  });

  it('renders keyboard-native workspace tabs and isolated split terminal panes', () => {
    const secondTask = Object.freeze({ ...runningTask, id: 'task-2', title: 'Second Task' });
    const secondSession = Object.freeze({ ...workingSession, id: 'session-2', taskId: 'task-2' });
    const overview: AgentWorkspaceOverview = Object.freeze({
      agents: availableAgents,
      projects: [
        {
          project,
          tasks: [
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              activeSession: workingSession,
              latestSession: workingSession,
            },
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              activeSession: secondSession,
              latestSession: secondSession,
              task: secondTask,
            },
          ],
        },
      ],
    });
    const layout = splitWorkspaceTerminal(
      openWorkspaceTab(defaultWorkspaceLayout, { taskId: 'task-2' }),
      { sessionId: 'session-2', taskId: 'task-2' },
    );
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
          layout,
          overview,
          selectedAgentId: 'codex',
          selectedTaskId: 'task-2',
          terminalSessionId: 'session-2',
        },
      }),
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('Workspace tabs');
    expect(markup).toContain('Second Task');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-label="Close workspace tab: Second Task"');
    expect(markup).toContain('aria-label="Terminal pane 2');
    expect(markup).toContain('data-active-terminal-pane="true"');
    expect(markup).toContain('aria-label="Close terminal pane 2"');
    expect(markup).toContain('Alt+]');
    expect(markup).toContain('Alt+Shift+]');
  });
});

describe('AgentWorkspaceView', () => {
  it('renders the latest Plan and explicit Accept and Revise actions while staying PLANNING', () => {
    const plan = Object.freeze({
      canonicalName: 'planning/plan.md' as const,
      content: '# Plan\n\n1. Inspect.\n2. Implement.\n3. Validate.',
      createdAt: 1_800_000_000_100,
      format: 'markdown' as const,
      id: 'plan-visible',
      kind: 'plan' as const,
      phase: 'PLANNING' as const,
      schemaVersion: 1 as const,
      sessionId: failedSession.id,
      taskId: planningTask.id,
      validation: 'VALID' as const,
    });
    const overview: AgentWorkspaceOverview = {
      ...planningOverview,
      projects: [
        {
          project,
          tasks: [
            {
              ...planningOverview.projects[0]!.tasks[0]!,
              artifacts: [plan],
              canAcceptPlan: true,
              canRevisePlan: true,
              canStartPlanning: false,
              latestPlan: plan,
              latestSession: failedSession,
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onAcceptPlan: () => undefined,
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectAgent: () => undefined,
        onSelectTask: () => undefined,
        onStartPlanning: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
          selectedTaskId: planningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('Current plan');
    expect(markup).toContain('plan-visible');
    expect(markup).toContain('1. Inspect.');
    expect(markup).toContain('Revise plan');
    expect(markup).toContain('Accept Plan and enter RUNNING');
    expect(markup).toContain(
      'Task phase</span><strong class="state-value__inner"><span aria-hidden="true" class="phase-dot phase-dot--planning',
    );
  });

  it('labels the first post-acceptance attempt as Start execution even though Session history is preserved', () => {
    const plan = Object.freeze({
      canonicalName: 'planning/plan.md' as const,
      content: '# Plan\n\nExecute only after acceptance.',
      createdAt: 1_800_000_000_100,
      format: 'markdown' as const,
      id: 'plan-accepted',
      kind: 'plan' as const,
      phase: 'PLANNING' as const,
      schemaVersion: 1 as const,
      sessionId: failedSession.id,
      taskId: runningTask.id,
      validation: 'VALID' as const,
    });
    const overview: AgentWorkspaceOverview = {
      ...failedOverview,
      projects: [
        {
          project,
          tasks: [
            {
              ...failedOverview.projects[0]!.tasks[0]!,
              artifacts: [plan],
              latestPlan: plan,
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
        onSelectAgent: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('>Start execution</span>');
    expect(markup).not.toContain('>Retry execution</button>');
  });

  it('renders incomplete dependencies as a blocked derived state without an execution action', () => {
    const overview: AgentWorkspaceOverview = {
      ...runningStartOverview,
      projects: [
        {
          project,
          tasks: [
            {
              ...runningStartOverview.projects[0]!.tasks[0]!,
              blocked: true,
              canStartExecution: false,
              dependencies: [
                {
                  id: 'task-required',
                  phase: 'RUNNING',
                  satisfied: false,
                  title: 'Prepare shared API',
                },
                {
                  id: 'task-complete',
                  phase: 'DONE',
                  satisfied: true,
                  title: 'Define contracts',
                },
              ],
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
        onSelectAgent: () => undefined,
        onSelectTask: () => undefined,
        onStartPlanning: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain(
      'Dependencies</span><strong class="state-value__inner"><span aria-hidden="true" class="phase-dot phase-dot--blocked',
    );
    expect(markup).toContain('Task dependencies');
    expect(markup).toContain('Prepare shared API');
    expect(markup).toContain('RUNNING · Required');
    expect(markup).toContain('Define contracts');
    expect(markup).toContain('DONE · Complete');
    expect(markup).toContain(
      'title="Complete all required Task dependencies before starting another Agent Session."',
    );
    expect(markup).toContain('disabled=""');
  });

  it('enables the accessible agent selector for Retry and labels current and historical identities', () => {
    const historicalSession = Object.freeze({ ...failedSession, agentId: 'legacy-agent' });
    const overview: AgentWorkspaceOverview = {
      agents: availableAgents,
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
              previousSession: historicalSession,
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
        onSelectAgent: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('aria-label="Coding agent"');
    expect(markup).toContain('Agent for next attempt');
    expect(markup).toContain('Used for the next planning or execution attempt.');
    expect(markup).not.toMatch(
      /<select[^>]*disabled=""[^>]*aria-label="Coding agent"|<select[^>]*aria-label="Coding agent"[^>]*disabled=""/u,
    );
    expect(markup).toContain('Codex (codex)');
    expect(markup).toContain('Future Agent (future-agent)');
    expect(markup).toContain('Available · Session resume');
    expect(markup).toContain('Unavailable · Executable not found');
    expect(markup).toContain('Codex (codex) · session-failed');
    expect(markup).toContain('legacy-agent · session-failed');
  });

  it('disables fresh execution when the catalog has no available agent', () => {
    const overview: AgentWorkspaceOverview = {
      ...planningOverview,
      agents: [availableAgents[1]!],
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
          activeAction: undefined,
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: undefined,
          selectedTaskId: planningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('No available agent');
    expect(markup).toContain('No configured coding agent is currently available.');
    expect(markup).toMatch(/<button class="primary-action" disabled=""/u);
  });

  it('disables Retry when the catalog has no available agent', () => {
    const overview: AgentWorkspaceOverview = {
      ...failedOverview,
      agents: [availableAgents[1]!],
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
          activeAction: undefined,
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: undefined,
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('No available agent');
    expect(markup).toContain('No configured coding agent is currently available.');
    expect(markup).toMatch(/<button class="primary-action" disabled=""/u);
    expect(markup).toContain('Retry execution');
  });

  it('renders a keyboard-native changed file list and only the selected bounded patch', () => {
    const changedFile = Object.freeze({
      area: 'STAGED' as const,
      kind: 'RENAMED' as const,
      path: 'src/new-name.ts',
      previousPath: 'src/old-name.ts',
    });
    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client: new FakeWorkspaceClient(),
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectAgent: () => undefined,
        onSelectTask: () => undefined,
        onSelectTaskChange: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          changeInspection: {
            diffError: undefined,
            diffLoading: false,
            kind: 'ready',
            result: { files: [changedFile], totalFiles: 1, truncated: false },
            selectedDiff: {
              ...changedFile,
              additions: 2,
              binary: false,
              deletions: 1,
              patch: { text: '-old\n+new\n', truncated: false },
            },
            selectedFile: changedFile,
            taskId: runningTask.id,
          },
          kind: 'ready',
          layout: defaultWorkspaceLayout,
          overview: runningStartOverview,
          selectedAgentId: 'codex',
          selectedTaskId: runningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(markup).toContain('Changed files');
    expect(markup).toContain('src/old-name.ts -&gt; src/new-name.ts');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('-old\n+new');
    expect(markup).toContain('+2');
    expect(markup).toContain('-1');
  });

  it('renders GitHub branch readiness and explicit Push/Create Pull Request actions', () => {
    const branch = pullRequestReady.branch;
    if (branch.kind !== 'ready') throw new Error('Expected ready Pull Request fixture.');
    const pushedState: TaskPullRequestState = Object.freeze({
      branch: Object.freeze({ ...branch, remoteHeadCommitId: branch.headCommitId }),
      canCreatePullRequest: true,
      canPush: false,
      pullRequest: openPullRequest,
    });
    const commonSnapshot = {
      actionError: undefined,
      activeAction: undefined,
      kind: 'ready' as const,
      layout: defaultWorkspaceLayout,
      overview: runningStartOverview,
      selectedAgentId: 'codex',
      selectedTaskId: runningTask.id,
      terminalSessionId: undefined,
    };

    const needsPush = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          ...commonSnapshot,
          pullRequestInspection: {
            kind: 'ready',
            result: pullRequestReady,
            taskId: runningTask.id,
          },
        },
      }),
    );
    const existing = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        onApproveReview: () => undefined,
        onRefresh: () => undefined,
        onRequestChanges: () => undefined,
        onRequestReview: () => undefined,
        onRetry: () => undefined,
        onRetryTask: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot: {
          ...commonSnapshot,
          pullRequestInspection: {
            kind: 'ready',
            result: pushedState,
            taskId: runningTask.id,
          },
        },
      }),
    );

    expect(needsPush).toContain('GitHub Pull Request');
    expect(needsPush).toContain('agentterm/AgentTerm');
    expect(needsPush).toContain('PUSH REQUIRED');
    expect(needsPush).toContain('Push Task branch');
    expect(existing).toContain('#42 · OPEN');
    expect(existing).toContain('https://github.com/agentterm/AgentTerm/pull/42');
    expect(existing).toContain('Refresh GitHub status');
    expect(existing).toContain('APPROVED');
    expect(existing).toContain('SUCCESS');
    expect(existing).toContain('3/3 passing');
    expect(existing).not.toContain('reopen');
  });

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
          layout: defaultWorkspaceLayout,
          overview: eligibleReviewOverview,
          selectedAgentId: 'codex',
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
          layout: defaultWorkspaceLayout,
          overview: pendingReviewOverview,
          selectedAgentId: 'codex',
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
    expect(markup).toContain(
      'Task phase</span><strong class="state-value__inner"><span aria-hidden="true" class="phase-dot phase-dot--review',
    );
  });

  it('renders validated artifact history as escaped Unicode text without changing Task state', () => {
    const overview: AgentWorkspaceOverview = {
      agents: availableAgents,
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
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
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
    expect(markup).toContain(
      'Task phase</span><strong class="state-value__inner"><span aria-hidden="true" class="phase-dot phase-dot--running phase-running--active',
    );
  });

  it('renders TaskPhase and AgentSessionStatus as separate states when a Session failed', () => {
    const client = new FakeWorkspaceClient();
    const snapshot: WorkspaceSnapshot = {
      actionError: undefined,
      kind: 'ready',
      layout: defaultWorkspaceLayout,
      overview: failedOverview,
      selectedAgentId: 'codex',
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
    expect(markup).toContain('Nối terminal tiếng Việt');
  });

  it('shows the prior failed attempt separately from the newly active Session', () => {
    const overview: AgentWorkspaceOverview = {
      agents: availableAgents,
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
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
          selectedTaskId: runningTask.id,
          activeAction: undefined,
          terminalSessionId: workingSession.id,
        },
      }),
    );

    expect(markup).toContain('Previous session');
    expect(markup).toContain('FAILED · Codex (codex) · session-failed');
    expect(markup).toContain('Codex (codex) · session-working');
  });

  it('renders immutable Quality Gate history newest-first without treating it as Task completion', () => {
    const failedTask = failedOverview.projects[0]!.tasks[0]!;
    const overview: AgentWorkspaceOverview = {
      agents: availableAgents,
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
          layout: defaultWorkspaceLayout,
          overview,
          selectedAgentId: 'codex',
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
    expect(markup).toContain(
      'Task phase</span><strong class="state-value__inner"><span aria-hidden="true" class="phase-dot phase-dot--running phase-running--active',
    );
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
          layout: defaultWorkspaceLayout,
          overview: planningOverview,
          selectedAgentId: 'codex',
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
        onSaveSettings: () => undefined,
        snapshot: {
          actionError: undefined,
          kind: 'ready',
          layout: Object.freeze({ activeTabId: undefined, tabs: Object.freeze([]) }),
          overview: { agents: availableAgents, projects: [] },
          selectedAgentId: 'codex',
          settings: defaultSettingsView,
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
    expect(empty).toContain('Open Project');
    expect(empty).toContain('<summary>Settings</summary>');
    expect(error).toContain('Workspace data could not be loaded.');
    expect(error).toContain('Retry');
  });

  it('renders keyboard-native Project, Task, and explicit planning onboarding controls', () => {
    const common = {
      client: new FakeWorkspaceClient(),
      onApproveReview: () => undefined,
      onRefresh: () => undefined,
      onRequestChanges: () => undefined,
      onRequestReview: () => undefined,
      onRetry: () => undefined,
      onRetryTask: () => undefined,
      onSelectTask: () => undefined,
      onStartTask: () => undefined,
    };
    const emptyProject = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        ...common,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          layout: Object.freeze({ activeTabId: undefined, tabs: Object.freeze([]) }),
          overview: emptyProjectOverview,
          selectedAgentId: 'codex',
          selectedTaskId: undefined,
          terminalSessionId: undefined,
        },
      }),
    );
    const backlog = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        ...common,
        snapshot: {
          actionError: undefined,
          activeAction: undefined,
          kind: 'ready',
          layout: createWorkspaceLayout({ taskId: planningTask.id }),
          overview: backlogOverview,
          selectedAgentId: 'codex',
          selectedTaskId: planningTask.id,
          terminalSessionId: undefined,
        },
      }),
    );

    expect(emptyProject).toContain('Create Task');
    expect(emptyProject).toContain('Task title');
    expect(emptyProject).toContain('Task brief');
    expect(emptyProject).toContain('textarea');
    expect(backlog).toContain('Begin planning');
    expect(backlog).toContain('Task brief');
    expect(backlog).toContain('Nối terminal an toàn');
    expect(backlog).not.toContain('Start planning');
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
