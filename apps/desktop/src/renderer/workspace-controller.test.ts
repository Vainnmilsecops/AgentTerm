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
  id: 'session-failed',
  status: 'FAILED',
  taskId: runningTask.id,
});
const workingSession: NonNullable<WorkspaceTaskOverview['activeSession']> = Object.freeze({
  agentId: 'codex',
  createdAt: 1_800_000_000_000,
  endedAt: undefined,
  id: 'session-working',
  status: 'WORKING',
  taskId: runningTask.id,
});
const planningOverview: AgentWorkspaceOverview = Object.freeze({
  projects: [
    {
      project,
      tasks: [
        {
          activeSession: undefined,
          canStartExecution: true,
          latestSession: undefined,
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
          activeSession: undefined,
          canStartExecution: true,
          latestSession: failedSession,
          task: runningTask,
        },
      ],
    },
  ],
});

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
                activeSession: undefined,
                canStartExecution: true,
                latestSession: undefined,
                task: planningTask,
              },
              {
                activeSession: undefined,
                canStartExecution: false,
                latestSession: undefined,
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
      startingTaskId: undefined,
    });
    expect(selectedTask(controller.snapshot)).toMatchObject({
      latestSession: { status: 'FAILED' },
      task: { phase: 'RUNNING' },
    });
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
      startingTaskId: undefined,
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
              activeSession: undefined,
              canStartExecution: true,
              latestSession: undefined,
              task: planningTask,
            },
            {
              activeSession: undefined,
              canStartExecution: true,
              latestSession: undefined,
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
              activeSession: workingSession,
              canStartExecution: true,
              latestSession: workingSession,
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
              activeSession: undefined,
              canStartExecution: true,
              latestSession: { ...workingSession, endedAt: 1_800_000_000_100, status: 'EXITED' },
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
  it('renders TaskPhase and AgentSessionStatus as separate states when a Session failed', () => {
    const client = new FakeWorkspaceClient();
    const snapshot: WorkspaceSnapshot = {
      actionError: undefined,
      kind: 'ready',
      overview: failedOverview,
      selectedTaskId: 'task-1',
      startingTaskId: undefined,
      terminalSessionId: undefined,
    };

    const markup = renderToStaticMarkup(
      createElement(AgentWorkspaceView, {
        client,
        onRefresh: () => undefined,
        onRetry: () => undefined,
        onSelectTask: () => undefined,
        onStartTask: () => undefined,
        snapshot,
      }),
    );

    expect(markup).toContain('Task phase');
    expect(markup).toContain('RUNNING');
    expect(markup).toContain('Latest session');
    expect(markup).toContain('FAILED');
    expect(markup).not.toContain('Task phase</span><strong>DONE');
    expect(markup).toContain('Nối terminal tiếng Việt');
  });

  it('renders loading, empty, and recoverable error states', () => {
    const client = new FakeWorkspaceClient();
    const common = {
      client,
      onRefresh: () => undefined,
      onRetry: () => undefined,
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
          startingTaskId: undefined,
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
