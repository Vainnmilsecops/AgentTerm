import { describe, expect, it } from 'vitest';

import {
  attachHostOwnership,
  createAgentSession,
  createAgentSessionHostOwnership,
  setProviderSessionId,
  type AgentSession,
} from '@agentterm/domain';

import { AgentSessionResumeUnavailableError, PtyRuntimeError } from './errors';
import type {
  AgentAvailability,
  AgentCatalog,
  AgentSessionRepository,
  HostReattachInspection,
  HostReattacher,
  PtyHandle,
  PtyRuntime,
  PtyTerminalSize,
} from './ports';
import { tryReattachAgentSession, tryResumeAgentSession } from './agent-session-recovery';

const createdAt = 1_800_000_000_000;
const initialSize: PtyTerminalSize = { columns: 80, rows: 24 };

function sessionWithOwnership(providerSessionId?: string): AgentSession {
  const base = createAgentSession({
    agentId: 'codex',
    createdAt,
    id: 'session-1',
    taskId: 'task-1',
  });
  const withOwnership = attachHostOwnership(
    base,
    createAgentSessionHostOwnership({
      conptyInPipeName: '\\\\.\\pipe\\in',
      conptyOutPipeName: '\\\\.\\pipe\\out',
      hostPid: 100,
      startedAt: 0,
    }),
  );
  return providerSessionId === undefined
    ? withOwnership
    : setProviderSessionId(withOwnership, providerSessionId);
}

class MemorySessions implements AgentSessionRepository {
  public constructor(public readonly values: AgentSession[]) {}
  public async append(): Promise<void> {}
  public async updateOwnership(): Promise<void> {}
  public async findById(id: string): Promise<AgentSession | undefined> {
    return this.values.find((session) => session.id === id);
  }
  public async insert(session: AgentSession): Promise<void> {
    this.values.push(session);
  }
  public async listActive(): Promise<readonly AgentSession[]> {
    return this.values.filter(
      (session) => session.status !== 'EXITED' && session.status !== 'FAILED',
    );
  }
  public async listByTaskId(taskId: string): Promise<readonly AgentSession[]> {
    return this.values.filter((session) => session.taskId === taskId);
  }
}

class FakeHandle implements PtyHandle {
  public readonly writes: string[] = [];
  public async write(input: string): Promise<void> {
    this.writes.push(input);
  }
  public async resize(): Promise<void> {}
  public async terminate(): Promise<void> {}
  public async dispose(): Promise<void> {}
}

class FakeRuntime implements PtyRuntime {
  public readonly handle = new FakeHandle();
  public reattachCalls = 0;
  public reattachFailure: PtyRuntimeError | undefined;
  public launchCalls = 0;
  public async open(): Promise<PtyHandle> {
    this.launchCalls += 1;
    return this.handle;
  }
  public async reattach(): Promise<PtyHandle> {
    this.reattachCalls += 1;
    if (this.reattachFailure !== undefined) {
      throw this.reattachFailure;
    }
    return this.handle;
  }
}

class FakeHostReattacher implements HostReattacher {
  public result: HostReattachInspection = { kind: 'alive' };
  public async inspect(): Promise<HostReattachInspection> {
    return this.result;
  }
}

function codexAdapter(availability: AgentAvailability) {
  return {
    identity: { displayName: 'Codex', id: 'codex' },
    inspect: async () => availability,
    buildLaunchCommand: async (request: {
      resumeSessionId?: string;
      workingDirectory: string;
    }) => ({
      arguments: request.resumeSessionId === undefined ? [] : ['resume', request.resumeSessionId],
      environment: {},
      executablePath: 'C:\\tools\\codex.exe',
      workingDirectory: request.workingDirectory,
    }),
  };
}

describe('tryReattachAgentSession', () => {
  it('returns SESSION_NOT_FOUND when the persisted row is missing', async () => {
    const runtime = new FakeRuntime();
    const reattacher = new FakeHostReattacher();
    const sessions = new MemorySessions([]);
    const result = await tryReattachAgentSession(
      { initialSize, sessionId: 'missing' },
      { agents: {} as AgentCatalog, clock: () => 0, hostReattacher: reattacher, runtime, sessions },
    );
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.reason).toBe('SESSION_NOT_FOUND');
    expect(runtime.reattachCalls).toBe(0);
  });

  it('returns NO_OWNERSHIP when the row has no recorded ownership', async () => {
    const runtime = new FakeRuntime();
    const reattacher = new FakeHostReattacher();
    const session = createAgentSession({
      agentId: 'codex',
      createdAt,
      id: 'session-1',
      taskId: 'task-1',
    });
    const sessions = new MemorySessions([session]);
    const result = await tryReattachAgentSession(
      { initialSize, sessionId: 'session-1' },
      { agents: {} as AgentCatalog, clock: () => 0, hostReattacher: reattacher, runtime, sessions },
    );
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.reason).toBe('NO_OWNERSHIP');
  });

  it('returns HOST_DEAD when the inspector reports the host is gone', async () => {
    const runtime = new FakeRuntime();
    const reattacher = new FakeHostReattacher();
    reattacher.result = { kind: 'dead', reason: 'PROCESS_GONE' };
    const sessions = new MemorySessions([sessionWithOwnership()]);
    const result = await tryReattachAgentSession(
      { initialSize, sessionId: 'session-1' },
      { agents: {} as AgentCatalog, clock: () => 0, hostReattacher: reattacher, runtime, sessions },
    );
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.reason).toBe('HOST_DEAD');
    expect(runtime.reattachCalls).toBe(0);
  });

  it('returns RUNTIME_REJECTED when the runtime refuses to reattach', async () => {
    const runtime = new FakeRuntime();
    runtime.reattachFailure = new PtyRuntimeError('spawn', 'CONPTY_UNAVAILABLE');
    const reattacher = new FakeHostReattacher();
    const sessions = new MemorySessions([sessionWithOwnership()]);
    const result = await tryReattachAgentSession(
      { initialSize, sessionId: 'session-1' },
      { agents: {} as AgentCatalog, clock: () => 0, hostReattacher: reattacher, runtime, sessions },
    );
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.reason).toBe('RUNTIME_REJECTED');
  });

  it('returns reattached handle when the runtime accepts the ownership record', async () => {
    const runtime = new FakeRuntime();
    const reattacher = new FakeHostReattacher();
    const sessions = new MemorySessions([sessionWithOwnership()]);
    const result = await tryReattachAgentSession(
      { initialSize, sessionId: 'session-1' },
      { agents: {} as AgentCatalog, clock: () => 0, hostReattacher: reattacher, runtime, sessions },
    );
    expect(result.kind).toBe('reattached');
    if (result.kind === 'reattached') {
      expect(result.handle).toBe(runtime.handle);
    }
    expect(runtime.reattachCalls).toBe(1);
  });
});

describe('tryResumeAgentSession', () => {
  it('throws PROVIDER_SESSION_ID_MISSING when the previous attempt never surfaced one', async () => {
    const runtime = new FakeRuntime();
    const sessions = new MemorySessions([sessionWithOwnership()]);
    const adapter = codexAdapter({
      capabilities: ['SESSION_RESUME'],
      executablePath: 'C:\\tools\\codex.exe',
      kind: 'available',
    });
    const agents: AgentCatalog = {
      findById: (id) => (id === 'codex' ? adapter : undefined),
      list: () => [adapter],
    };

    await expect(
      tryResumeAgentSession(
        {
          eventSink: () => undefined,
          initialSize,
          previousSessionId: 'session-1',
          request: { environment: {}, workingDirectory: 'C:\\work' },
        },
        {
          agents,
          clock: () => createdAt + 5,
          hostReattacher: new FakeHostReattacher(),
          runtime,
          sessions,
        },
      ),
    ).rejects.toBeInstanceOf(AgentSessionResumeUnavailableError);
  });

  it('throws RESUME_UNSUPPORTED when the adapter has no SESSION_RESUME capability', async () => {
    const runtime = new FakeRuntime();
    const sessions = new MemorySessions([sessionWithOwnership('provider-xyz')]);
    const adapter = codexAdapter({
      capabilities: [],
      executablePath: 'C:\\tools\\codex.exe',
      kind: 'available',
    });
    const agents: AgentCatalog = {
      findById: (id) => (id === 'codex' ? adapter : undefined),
      list: () => [adapter],
    };

    await expect(
      tryResumeAgentSession(
        {
          eventSink: () => undefined,
          initialSize,
          previousSessionId: 'session-1',
          request: { environment: {}, workingDirectory: 'C:\\work' },
        },
        {
          agents,
          clock: () => createdAt + 5,
          hostReattacher: new FakeHostReattacher(),
          runtime,
          sessions,
        },
      ),
    ).rejects.toMatchObject({ reason: 'RESUME_UNSUPPORTED' });
  });

  it('records a fresh session row with the persisted provider session id when resume succeeds', async () => {
    const runtime = new FakeRuntime();
    const sessions = new MemorySessions([sessionWithOwnership('provider-xyz')]);
    const adapter = codexAdapter({
      capabilities: ['SESSION_RESUME'],
      executablePath: 'C:\\tools\\codex.exe',
      kind: 'available',
    });
    const agents: AgentCatalog = {
      findById: (id) => (id === 'codex' ? adapter : undefined),
      list: () => [adapter],
    };
    const result = await tryResumeAgentSession(
      {
        eventSink: () => undefined,
        initialSize,
        previousSessionId: 'session-1',
        request: { environment: {}, workingDirectory: 'C:\\work' },
      },
      {
        agents,
        clock: () => createdAt + 5,
        hostReattacher: new FakeHostReattacher(),
        runtime,
        sessions,
      },
    );
    expect(result.session.providerSessionId).toBe('provider-xyz');
    expect(result.session.id).not.toBe('session-1');
    expect(runtime.launchCalls).toBe(1);
    expect(sessions.values.find((entry) => entry.id === result.session.id)).toBeDefined();
  });
});
