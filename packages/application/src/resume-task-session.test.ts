import { describe, expect, it, vi } from 'vitest';
import { createAgentSession, createTask, setProviderSessionId } from '@agentterm/domain';
import { resumeTaskSession, type ResumeTaskSessionDependencies } from './resume-task-session';

function fixture() {
  const task = createTask({ id: 'task', projectId: 'project', title: 'Resume' });
  const previous = setProviderSessionId(
    createAgentSession({ id: 'old', taskId: task.id, agentId: 'codex', createdAt: 1 }),
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
    coordinator: { start },
    git: { inspect },
    sessions: { findById: async () => previous },
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
    expect(f.inspect).toHaveBeenCalledOnce();
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
