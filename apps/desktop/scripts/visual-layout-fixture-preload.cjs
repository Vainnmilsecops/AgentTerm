/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const { contextBridge } = require('electron');

const project = Object.freeze({ id: 'fixture-project-agentterm', name: 'AgentTerm Desktop' });
const emptyProject = Object.freeze({ id: 'fixture-project-empty', name: 'Empty Project' });
const agent = Object.freeze({
  capabilities: Object.freeze([]),
  displayName: 'Codex',
  id: 'codex',
  kind: 'available',
});

function createTaskOverview(id, phase, title, brief, overrides = {}) {
  return Object.freeze({
    activeSession: undefined,
    artifacts: Object.freeze([]),
    blocked: false,
    canAcceptPlan: false,
    canApproveReview: false,
    canBeginPlanning: phase === 'BACKLOG',
    canRequestChanges: false,
    canRequestReview: phase === 'RUNNING',
    canRetryExecution: false,
    canRevisePlan: false,
    canRunQualityGate: phase !== 'REVIEW' && phase !== 'DONE',
    canStartExecution: phase === 'RUNNING',
    canStartPlanning: phase === 'PLANNING',
    dependencies: Object.freeze([]),
    latestPlan: undefined,
    latestReview: undefined,
    latestSession: undefined,
    previousSession: undefined,
    qualityGateRuns: Object.freeze([]),
    reviewHistory: Object.freeze([]),
    task: Object.freeze({ brief, id, phase, projectId: project.id, title }),
    ...overrides,
  });
}

const tasks = Object.freeze([
  createTaskOverview(
    'task-running',
    'RUNNING',
    'Xây dựng desktop workspace ổn định cho tiêu đề rất dài, Unicode và cửa sổ hẹp',
    'Giữ Kanban, Task Inspector và Agent Console rõ ràng khi resize; không làm mất focus bàn phím hoặc lịch sử Session.',
  ),
  createTaskOverview(
    'task-backlog',
    'BACKLOG',
    'Define keyboard-first workspace navigation',
    'Map Projects, Tasks, sessions, tabs, panes and focus restoration before execution begins.',
  ),
  createTaskOverview(
    'task-planning',
    'PLANNING',
    'Plan resilient Electron window layout',
    'Cover the default desktop window and the supported 520 by 480 minimum window.',
  ),
  createTaskOverview(
    'task-review',
    'REVIEW',
    'Review terminal dock and focus restoration',
    'Verify that evidence remains separate from Task completion and terminal state.',
  ),
  createTaskOverview(
    'task-done',
    'DONE',
    'Ship verified project onboarding flow',
    'The completed fixture keeps all five Task phases visible in the Project Board.',
  ),
]);

const workspace = Object.freeze({
  agents: Object.freeze([agent]),
  projects: Object.freeze([
    Object.freeze({
      project,
      tasks,
    }),
    Object.freeze({
      project: emptyProject,
      tasks: Object.freeze([]),
    }),
  ]),
});

const settings = Object.freeze({
  agents: Object.freeze([
    Object.freeze({
      capabilities: Object.freeze([]),
      configuredExecutablePath: undefined,
      detectedExecutablePath: 'C:\\AgentTermFixture\\codex.exe',
      displayName: 'Codex',
      id: 'codex',
      kind: 'available',
      version: 'fixture',
    }),
  ]),
  settings: Object.freeze({
    agentExecutables: Object.freeze([]),
    defaultAgentId: 'codex',
    revision: 0,
    schemaVersion: 1,
    terminalFontSize: 14,
  }),
});

const emptyChanges = Object.freeze({
  files: Object.freeze([]),
  totalFiles: 0,
  truncated: false,
});
const blockedPullRequest = Object.freeze({
  branch: Object.freeze({ kind: 'blocked', reason: 'WORKTREE_NOT_READY' }),
  canCreatePullRequest: false,
  canPush: false,
  pullRequest: undefined,
});

const noOperation = async () => undefined;

const api = Object.freeze({
  acceptTaskPlan: noOperation,
  addTaskDependency: async ({ dependencyTaskId, taskId }) =>
    Object.freeze({ dependencyTaskId, taskId }),
  approveTaskReview: noOperation,
  attachTerminal: async () =>
    Object.freeze({
      detach: () => undefined,
      resize: noOperation,
      write: noOperation,
    }),
  beginTaskPlanning: noOperation,
  createArtifact: async (input) =>
    Object.freeze({
      canonicalName: 'running/execution-summary.md',
      content: input.content,
      createdAt: input.createdAt,
      format: 'markdown',
      id: input.id,
      kind: input.kind,
      phase: 'RUNNING',
      schemaVersion: 1,
      sessionId: input.sessionId,
      taskId: input.taskId,
      validation: 'VALID',
    }),
  createTask: async () => Object.freeze({ taskId: 'fixture-created-task' }),
  createTaskPullRequest: noOperation,
  getTaskFileDiff: async (input) =>
    Object.freeze({
      additions: 0,
      area: input.area,
      binary: false,
      deletions: 0,
      kind: 'MODIFIED',
      path: input.path,
    }),
  inspectTaskPullRequest: async () => blockedPullRequest,
  listProjectTasks: async () => Object.freeze(tasks.map(({ task }) => task)),
  listQualityGateDetails: async () => Object.freeze([]),
  listQualityGates: async () => Object.freeze([]),
  listTaskChanges: async () => emptyChanges,
  listTaskDependencies: async () => Object.freeze([]),
  listTaskReviews: async () => Object.freeze([]),
  loadSettings: async () => settings,
  loadWorkspace: async () => workspace,
  openProject: async () => 'CANCELLED',
  pushTaskBranch: noOperation,
  refreshTaskPullRequest: noOperation,
  registerQualityGate: noOperation,
  removeTaskDependency: async () => false,
  requestTaskChanges: noOperation,
  requestTaskReview: noOperation,
  retryTaskExecution: noOperation,
  runQualityGate: noOperation,
  startTaskExecution: noOperation,
  startTaskPlanning: noOperation,
  unregisterQualityGate: async () => false,
  updateSettings: async () => settings,
});

contextBridge.exposeInMainWorld('agenttermWorkspace', api);
