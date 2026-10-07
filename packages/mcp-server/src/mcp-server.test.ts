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

  public async listRecentByTaskId(taskId: string, limit: number): Promise<readonly TaskReview[]> {
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
  public readonly snapshots = new Map<
    string,
    { lines: string[]; capturedAt: number; truncated: boolean }
  >();

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
    dependencies: {
      paneSnapshots,
      projects,
      reviews,
      sessions,
      tasks: taskCatalog,
      taskRepository,
    },
    paneSnapshots,
    projects,
    reviews,
    sessions,
    taskCatalog,
    taskRepository,
  };
}

describe('MCP server', () => {
  it.each(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', 'future-version'])(
    'negotiates the read-only protocol with client version %s',
    async (version) => {
      const { dependencies } = makeDeps();
      const server = new McpServer({
        authToken: 'token',
        handlers: buildReadOnlyHandlers(dependencies),
      });
      const result = await server.dispatch(
        {
          id: 1,
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: 'client', version: '1' },
          },
        },
        { token: 'token' },
      );
      expect(result.response).toMatchObject({
        id: 1,
        result: { protocolVersion: version === 'future-version' ? '2025-11-25' : version },
      });
    },
  );

  it('requires authorization on initialize and every tool request', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const init = {
      id: 1,
      jsonrpc: '2.0' as const,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'client', version: '1' },
      },
    };
    expect((await server.dispatch(init, { token: 'bad' })).response).toMatchObject({
      error: { code: -32001 },
    });
    await server.dispatch(init, { token: 'token' });
    expect(
      await server.dispatch(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { token: 'bad' },
      ),
    ).toEqual({ response: undefined });
    expect(
      (await server.dispatch({ id: 2, jsonrpc: '2.0', method: 'tools/list' }, { token: 'token' }))
        .response,
    ).toMatchObject({ error: { code: -32002 } });
    await server.dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { token: 'token' },
    );
    for (const method of ['tools/list', 'tools/call', 'ping']) {
      expect(
        (
          await server.dispatch(
            {
              id: 2,
              jsonrpc: '2.0',
              method,
              params: { name: 'get-task', arguments: { taskId: 'task-1' } },
            },
            { token: 'bad' },
          )
        ).response,
      ).toMatchObject({ error: { code: -32001 } });
    }
  });

  it.each([undefined, ''])(
    'denies access when the configured local grant is %s',
    async (authToken) => {
      const { dependencies } = makeDeps();
      const server = new McpServer({ authToken, handlers: buildReadOnlyHandlers(dependencies) });
      expect(
        (await server.dispatch({ id: 1, jsonrpc: '2.0', method: 'ping' }, { token: authToken }))
          .response,
      ).toMatchObject({ error: { code: -32001 } });
    },
  );

  it('rejects invalid tool arguments, unknown tools and prototype names', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    await server.dispatch(
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'client', version: '1' },
        },
      },
      { token: 'token' },
    );
    await server.dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { token: 'token' },
    );
    const invalid = await server.dispatch(
      {
        id: 2,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get-task', arguments: { taskId: 42 } },
      },
      { token: 'token' },
    );
    expect(invalid.response).toMatchObject({
      result: { isError: true, content: [{ type: 'text' }] },
    });
    for (const name of ['create-task', 'constructor', '__proto__']) {
      expect(
        (
          await server.dispatch(
            { id: 3, jsonrpc: '2.0', method: 'tools/call', params: { name } },
            { token: 'token' },
          )
        ).response,
      ).toMatchObject({ error: { code: -32602 } });
    }
    expect(
      (
        await server.dispatch(
          {
            id: 4,
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name: 'get-task', arguments: [] },
          },
          { token: 'token' },
        )
      ).response,
    ).toMatchObject({ error: { code: -32602 } });
    const extra = await server.dispatch(
      {
        id: 5,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list-projects', arguments: { limit: 1.5, unexpected: true } },
      },
      { token: 'token' },
    );
    expect(extra.response).toMatchObject({ result: { isError: true } });
  });
  it('negotiates initialization, discovers tools, and calls the Application read view through MCP', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const initialized = await server.dispatch(
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0' },
        },
      },
      { token: 'token' },
    );
    expect(initialized.response).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agentterm', version: '0.0.0' },
      },
    });
    expect(
      await server.dispatch(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { token: 'token' },
      ),
    ).toEqual({ response: undefined });
    const listed = await server.dispatch(
      { id: 2, jsonrpc: '2.0', method: 'tools/list' },
      { token: 'token' },
    );
    expect(listed.response).toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'get-task',
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          }),
        ]),
      },
    });
    const called = await server.dispatch(
      {
        id: 3,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get-task', arguments: { taskId: 'task-1' } },
      },
      { token: 'token' },
    );
    const result = (
      called.response as { result: { content: { type: string; text: string }[]; isError: boolean } }
    ).result;
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      id: 'task-1',
      title: 'Plan audit',
      phase: 'PLANNING',
    });
  });

  it('rejects standard tool requests before the initialized notification', async () => {
    const { dependencies } = makeDeps();
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
    });
    const response = await server.dispatch(
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get-task', arguments: { taskId: 'task-1' } },
      },
      { token: 'token' },
    );
    expect(response.response).toMatchObject({ id: 1, error: { code: -32002 } });
  });

  it('does not reveal backend errors, provider data or raw request names in protocol errors and logs', async () => {
    const { dependencies } = makeDeps();
    dependencies.taskRepository.findById = async () => {
      throw new Error('SECRET_TOKEN C:\\private\\database');
    };
    const logs: string[] = [];
    const server = new McpServer({
      authToken: 'token',
      handlers: buildReadOnlyHandlers(dependencies),
      log: (entry) => logs.push(entry),
    });
    const failed = await server.dispatch(
      { id: 1, jsonrpc: '2.0', method: 'get-task', params: { taskId: 'task-1' } },
      { token: 'token' },
    );
    const unknown = await server.dispatch(
      { id: 2, jsonrpc: '2.0', method: 'SECRET_TOKEN' },
      { token: 'token' },
    );
    await server.dispatch(
      {
        id: 3,
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'client', version: '1' },
        },
      },
      { token: 'token' },
    );
    await server.dispatch(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { token: 'token' },
    );
    const toolFailed = await server.dispatch(
      {
        id: 4,
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'get-task', arguments: { taskId: 'task-1' } },
      },
      { token: 'token' },
    );
    expect(JSON.stringify([failed, toolFailed, unknown, logs])).not.toMatch(/SECRET_TOKEN|private/);
    expect(failed.response).toMatchObject({ id: 1, error: { code: -32603 } });
    expect(toolFailed.response).toMatchObject({
      id: 4,
      result: { isError: true, content: [{ type: 'text' }] },
    });
  });
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
        result: [{ id: 'project-1', name: 'AgentTerm', rootPath: 'C:/work/AgentTerm' }],
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
