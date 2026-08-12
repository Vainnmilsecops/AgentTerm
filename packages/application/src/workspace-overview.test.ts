import { describe, expect, it } from 'vitest';

import {
  createAgentSession,
  createTask,
  recordAgentSessionEvent,
  TaskPhase,
  transitionTask,
  type AgentSession,
  type Task,
} from '@agentterm/domain';

import {
  loadAgentWorkspace,
  type AgentSessionRepository,
  type LocalProject,
  type ProjectCatalog,
  type TaskCatalog,
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

    const workspace = await loadAgentWorkspace(
      new FakeProjectCatalog([project]),
      new FakeTaskCatalog([runningTask, secondTask]),
      new FakeSessionRepository([exited, working, olderActive, latestFailed]),
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
              canRetryExecution: false,
              canStartExecution: false,
              latestSession: workingSummary,
              previousSession: summarize(exited),
              task: runningTask,
            },
            {
              activeSession: olderActiveSummary,
              canRetryExecution: false,
              canStartExecution: false,
              latestSession: latestFailedSummary,
              previousSession: olderActiveSummary,
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
    );

    expect(workspace.projects[0]?.tasks[0]).toMatchObject({
      activeSession: undefined,
      canRetryExecution: true,
      canStartExecution: false,
      latestSession: { id: failed.id, status: 'FAILED' },
      previousSession: undefined,
      task: { phase: 'RUNNING' },
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
