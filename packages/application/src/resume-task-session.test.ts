import { describe, expect, it, vi } from 'vitest';
import {
  createAgentSession,
  createTask,
  recordAgentSessionEvent,
  setProviderSessionId,
} from '@agentterm/domain';
import { inspectSessionRecovery } from './session-recovery-readiness';
import { resumeTaskSession, type ResumeTaskSessionDependencies } from './resume-task-session';

function fixture() {
  const task = createTask({ id: 'task', projectId: 'project', title: 'Resume' });
  const previous = setProviderSessionId(
    recordAgentSessionEvent(
      createAgentSession({ id: 'old', taskId: task.id, agentId: 'codex', createdAt: 1 }),
      {
        kind: 'RUNTIME_FAILED',
        code: 'RUNTIME_OWNERSHIP_LOST',
        stage: 'RUNTIME',
        fatal: true,
        occurredAt: 2,
      },
    ),
    'provider',
  );
  const worktree = {
    taskId: task.id,
    lifecycleState: 'PRESENT',
    repositoryRootPath: 'C:\\repo',
    worktreePath: 'C:\\worktrees\\task',
    pathIdentity: 'identity',
    branchName: 'task',
    baseRefName: 'main',
    baseCommitId: 'base',
  } as const;
  const start = vi.fn(async () => ({ ...previous, id: 'new' }));
  const inspect = vi.fn(async () => ({ kind: 'present', worktree }));
  const findByTaskId = vi.fn(async () => worktree);
  const dependencies = {
    agents: {
      findById: () => ({
        inspect: async () => ({ kind: 'available', capabilities: ['SESSION_RESUME'] }),
      }),
    },
    qualityGateRuns: { listByTaskId: async () => [] },
    taskDependencies: { listByTaskId: async () => [] },
    coordinator: { start },
    git: { inspect },
    sessions: { findById: async () => previous, listByTaskId: async () => [previous] },
    tasks: { findById: async () => task },
    worktrees: { findByTaskId },
  } as unknown as ResumeTaskSessionDependencies;
  return { dependencies, start, inspect, findByTaskId };
}

const input = {
  previousSessionId: 'old',
  sessionId: 'new',
  initialSize: { columns: 80, rows: 24 },
  environment: {},
  eventSink: () => {},
};

describe('resumeTaskSession', () => {
  it('reports missing conversation identity without probing the worktree', async () => {
    const f = fixture();
    const previous = (await f.dependencies.sessions.findById('old'))!;
    vi.spyOn(f.dependencies.sessions, 'findById').mockResolvedValue({
      ...previous,
      providerSessionId: undefined,
    });
    expect((await inspectSessionRecovery('old', f.dependencies)).reason).toBe(
      'PROVIDER_ID_MISSING',
    );
    expect(await resumeTaskSession(input, f.dependencies)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });

  it('blocks a settled session while another writer is active', async () => {
    const f = fixture();
    const previous = (await f.dependencies.sessions.findById('old'))!;
    vi.spyOn(f.dependencies.sessions, 'listByTaskId').mockResolvedValue([
      previous,
      createAgentSession({ id: 'active', taskId: previous.taskId, agentId: 'codex', createdAt: 3 }),
    ]);
    expect((await inspectSessionRecovery('old', f.dependencies)).reason).toBe('ACTIVE_SESSION');
    expect(await resumeTaskSession(input, f.dependencies)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('blocks unfinished dependencies before starting a process', async () => {
    const f = fixture();
    vi.spyOn(f.dependencies.taskDependencies, 'listByTaskId').mockResolvedValue([
      { taskId: 'task', dependencyTaskId: 'dependency' },
    ] as never);
    expect((await inspectSessionRecovery('old', f.dependencies)).reason).toBe('DEPENDENCY_BLOCKED');
    expect(await resumeTaskSession(input, f.dependencies)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('refuses to resume while a quality gate is running', async () => {
    const f = fixture();
    vi.spyOn(f.dependencies.qualityGateRuns, 'listByTaskId').mockResolvedValue([
      { status: 'RUNNING' },
    ] as never);
    expect((await inspectSessionRecovery('old', f.dependencies)).reason).toBe('GATE_RUNNING');
    expect(await resumeTaskSession(input, f.dependencies)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });
  it('refuses to resume a historical attempt after a newer one', async () => {
    const f = fixture();
    const previous = (await f.dependencies.sessions.findById('old'))!;
    vi.spyOn(f.dependencies.sessions, 'listByTaskId').mockResolvedValue([
      previous,
      { ...previous, id: 'newer' },
    ]);
    expect((await inspectSessionRecovery('old', f.dependencies)).reason).toBe('NEWER_ATTEMPT');
    expect(await resumeTaskSession(input, f.dependencies)).toBeUndefined();
  });
  it('launches in the inspected worktree rather than using the Task id as a path', async () => {
    const f = fixture();
    const result = await resumeTaskSession(input, f.dependencies);
    expect(result?.id).toBe('new');
    expect(f.start).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: 'C:\\worktrees\\task',
        taskId: 'task',
        resumeFromSessionId: 'old',
        expectedTaskPhase: 'BACKLOG',
      }),
    );
    expect(f.inspect).toHaveBeenCalled();
  });

  it('does not launch when the worktree is missing on disk', async () => {
    const f = fixture();
    f.inspect.mockResolvedValue({ kind: 'missing', worktree: await f.findByTaskId() });
    expect(await resumeTaskSession(input, f.dependencies)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
  });

  it('does not launch without a persisted provider conversation id', async () => {
    const f = fixture();
    const dependencies = {
      ...f.dependencies,
      sessions: { ...f.dependencies.sessions, findById: async () => undefined },
    };
    expect(await resumeTaskSession(input, dependencies)).toBeUndefined();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });
});
