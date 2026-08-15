import { describe, expect, it } from 'vitest';

import type {
  AgentPaneSnapshotProvider,
  AgentSessionSummaryReader,
  LocalProject,
  McpTaskDetail,
  ProjectCatalog,
  Task,
  TaskCatalog,
  TaskRepository,
  TaskReviewRepository,
} from '@agentterm/application';
import { TaskPhase, type TaskReview } from '@agentterm/domain';

import { McpServer, MCP_JSON_RPC_ERRORS, MCP_TOOL_DEFINITIONS } from './index';
import { buildReadOnlyHandlers } from './handlers/read-only';

class InMemoryProjectCatalog implements ProjectCatalog {
  public readonly projects: LocalProject[];

  public constructor(projects: LocalProject[]) {
    this.projects = projects;
  }

  public async recordOpen(): Promise<LocalProject> {
    throw new Error('not used in tests');
  }

  public async listRecent(): Promise<readonly LocalProject[]> {
    return Object.freeze([...this.projects]);
  }
}

class InMemoryTaskCatalog implements TaskCatalog {
  public readonly tasksByProject = new Map<string, Task[]>();

  public constructor(tasks: readonly Task[]) {
    for (const task of tasks) {
      const existing = this.tasksByProject.get(task.projectId) ?? [];
      existing.push(task);
      this.tasksByProject.set(task.projectId, existing);
    }
  }

  public async listByProjectId(projectId: string): Promise<readonly Task[]> {
    return Object.freeze([...(this.tasksByProject.get(projectId) ?? [])]);
  }
}

class InMemoryTaskRepository implements TaskRepository {
  public readonly tasks = new Map<string, Task>();

  public constructor(tasks: readonly Task[]) {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  public async findById(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }

  public async insert(): Promise<void> {
    throw new Error('not used in tests');
  }

  public async update(): Promise<void> {
    throw new Error('not used in tests');
  }
}

class InMemoryTaskReviewRepository implements TaskReviewRepository {
  public readonly reviews = new Map<string, TaskReview[]>();

  public constructor(reviews: readonly TaskReview[]) {
    for (const review of reviews) {
      const existing = this.reviews.get(review.taskId) ?? [];
      existing.push(review);
      this.reviews.set(review.taskId, existing);
    }
  }

  public async listByTaskId(taskId: string): Promise<readonly TaskReview[]> {
    return Object.freeze([...(this.reviews.get(taskId) ?? [])]);
  }

  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly TaskReview[]> {
    return Object.freeze((this.reviews.get(taskId) ?? []).slice(-limit));
  }

  public async findById(): Promise<TaskReview | undefined> {
    throw new Error('not used in tests');
  }

  public async begin(): Promise<void> {
    throw new Error('not used in tests');
  }

  public async decide(): Promise<void> {
    throw new Error('not used in tests');
  }
}

class InMemorySessionReader implements AgentSessionSummaryReader {
  public readonly sessions = new Map<string, { agentId: string; id: string; taskId: string }[]>();

  public constructor(records: readonly { agentId: string; id: string; taskId: string }[]) {
    for (const record of records) {
      const existing = this.sessions.get(record.taskId) ?? [];
      existing.push(record);
      this.sessions.set(record.taskId, existing);
    }
  }

  public async listByTaskId(taskId: string) {
    return Object.freeze(
      (this.sessions.get(taskId) ?? []).map((record) => ({
        agentId: record.agentId,
        createdAt: 0,
        endedAt: undefined,
        failureCode: undefined,
        id: record.id,
        status: 'IDLE' as const,
        taskId,
      })),
    );
  }
}

class InMemoryPaneSnapshot implements AgentPaneSnapshotProvider {
  public readonly snapshots = new Map<string, { lines: string[]; capturedAt: number; truncated: boolean }>();

  public async readSnapshot(input: { sessionId: string }) {
    const snapshot = this.snapshots.get(input.sessionId);
    if (snapshot === undefined) {
      return undefined;
    }
    return {
      boundedLines: Object.freeze([...snapshot.lines]),
      capturedAt: snapshot.capturedAt,
      sessionId: input.sessionId,
      truncated: snapshot.truncated,
    };
  }
}

function makeDeps() {
  const projects = new InMemoryProjectCatalog([
    { id: 'project-1', name: 'AgentTerm', rootPath: 'C:/work/AgentTerm' },
  ]);
  const tasks = [
    { id: 'task-1', phase: TaskPhase.PLANNING, projectId: 'project-1', title: 'Plan audit' },
  ];
  const taskCatalog = new InMemoryTaskCatalog(tasks);
  const taskRepository = new InMemoryTaskRepository(tasks);
  const reviews = new InMemoryTaskReviewRepository([]);
  const sessions = new InMemorySessionReader([
    { agentId: 'agent-1', id: 'session-1', taskId: 'task-1' },
  ]);
  const paneSnapshots = new InMemoryPaneSnapshot();
  paneSnapshots.snapshots.set('session-1', {
    capturedAt: 1,
    lines: ['line-1', 'line-2'],
    truncated: false,
  });
  return {
    dependencies: { paneSnapshots, projects, reviews, sessions, tasks: taskCatalog, taskRepository },
    paneSnapshots,
    projects,
    reviews,
    sessions,
    taskCatalog,
    taskRepository,
  };
}

describe('MCP server', () => {
  it('exposes the four read-only tool definitions', () => {
    expect(MCP_TOOL_DEFINITIONS.map((definition) => definition.name)).toEqual([
      'list-projects',
      'list-tasks',
      'get-task',
      'read-pane-content',
    ]);
  });

  it('rejects requests when the supplied token does not match', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'expected-token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const result = await server.dispatch(
      { id: 1, jsonrpc: '2.0', method: 'list-projects' },
      { token: 'wrong-token' },
    );
    expect(result.response).toMatchObject({
      error: {
        code: MCP_JSON_RPC_ERRORS.AUTHENTICATION_REQUIRED,
      },
      id: 1,
      jsonrpc: '2.0',
    });
  });

  it('rejects requests when the MCP token is not configured (default off)', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: undefined,
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const result = await server.dispatch(
      { id: 1, jsonrpc: '2.0', method: 'list-projects' },
      { token: 'any' },
    );
    expect(result.response).toMatchObject({
      error: { code: MCP_JSON_RPC_ERRORS.AUTHENTICATION_REQUIRED },
    });
  });

  it('returns a method-not-found error for unknown methods', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const result = await server.dispatch(
      { id: 2, jsonrpc: '2.0', method: 'launch-agent' },
      { token: 'token' },
    );
    expect(result.response).toMatchObject({
      error: { code: MCP_JSON_RPC_ERRORS.METHOD_NOT_FOUND },
      id: 2,
    });
  });

  it('exposes the list-projects tool through JSON-RPC dispatch', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const result = await server.dispatch(
      { id: 3, jsonrpc: '2.0', method: 'list-projects' },
      { token: 'token' },
    );
    expect(result.response).toEqual(
      expect.objectContaining({
        id: 3,
        jsonrpc: '2.0',
        result: [
          { id: 'project-1', name: 'AgentTerm', rootPath: 'C:/work/AgentTerm' },
        ],
      }),
    );
  });

  it('exposes the get-task tool and returns null for missing tasks', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const missing = await server.dispatch(
      { id: 4, jsonrpc: '2.0', method: 'get-task', params: { taskId: 'task-missing' } },
      { token: 'token' },
    );
    expect(missing.response).toEqual(
      expect.objectContaining({ id: 4, jsonrpc: '2.0', result: null }),
    );
    const present = await server.dispatch(
      { id: 5, jsonrpc: '2.0', method: 'get-task', params: { taskId: 'task-1' } },
      { token: 'token' },
    );
    const detail = (present.response as { readonly result: McpTaskDetail } | undefined)?.result;
    expect(detail?.id).toBe('task-1');
    expect(detail?.phase).toBe(TaskPhase.PLANNING);
    expect(detail?.recentSessions).toHaveLength(1);
  });

  it('exposes the read-pane-content tool and returns bounded lines', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const result = await server.dispatch(
      { id: 6, jsonrpc: '2.0', method: 'read-pane-content', params: { sessionId: 'session-1' } },
      { token: 'token' },
    );
    expect(result.response).toEqual(
      expect.objectContaining({
        id: 6,
        jsonrpc: '2.0',
        result: {
          boundedLines: ['line-1', 'line-2'],
          capturedAt: 1,
          sessionId: 'session-1',
          truncated: false,
        },
      }),
    );
  });

  it('returns an invalid-params error when required parameters are missing', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const result = await server.dispatch(
      { id: 7, jsonrpc: '2.0', method: 'get-task', params: {} },
      { token: 'token' },
    );
    expect(result.response).toMatchObject({
      error: { code: MCP_JSON_RPC_ERRORS.INVALID_PARAMS },
      id: 7,
    });
  });
});