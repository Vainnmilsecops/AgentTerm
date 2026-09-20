import { describe, expect, it, vi } from 'vitest';
import {
  prepareTaskContextHandoff,
  type TaskContextHandoffDependencies,
} from './task-context-handoff';

function fixture() {
  const attachment = {
    id: 'file',
    taskId: 'task',
    sessionId: 'session',
    name: 'note.txt',
    mime: 'text/plain',
    size: 10,
    digest: 'a'.repeat(64),
    createdAt: 1,
  };
  const worktree = {
    lifecycleState: 'PRESENT',
    worktreePath: 'C:/task',
    repositoryRootPath: 'C:/repo',
  };
  const exportToWorktree = vi.fn(async () => 'agentterm-context/file.txt');
  const adapter = {
    identity: { id: 'test', displayName: 'Test' },
    inspect: async () => ({ kind: 'available', capabilities: ['FILE_CONTEXT'] }),
    buildContextPrompt: () => 'prompt',
  };
  const deps = {
    qualityGateRuns: { listByTaskId: async () => [] },
    sessions: {
      findById: async () => ({ id: 'session', taskId: 'task', agentId: 'test', status: 'WORKING' }),
      listByTaskId: async () => [{ id: 'session' }],
    },
    agents: { findById: () => adapter },
    repository: { listByTaskId: async () => [attachment] },
    worktrees: { findByTaskId: async () => worktree },
    git: { inspect: async () => ({ kind: 'present', worktree }) },
    exporter: { exportToWorktree },
  } as unknown as TaskContextHandoffDependencies;
  return { deps, attachment, adapter, exportToWorktree };
}
const input = {
  taskId: 'task',
  sessionId: 'session',
  attachmentIds: ['file'],
  confirmWorktreeCopy: true as const,
};
describe('prepare task context handoff', () => {
  it('reuses same-task context from a historical session without changing its provenance', async () => {
    const f = fixture();
    f.attachment.sessionId = 'previous';
    const original = { ...f.attachment };
    const currentLookup = f.deps.sessions.findById;
    vi.spyOn(f.deps.sessions, 'findById').mockImplementation(async (id) =>
      id === 'previous'
        ? ({ id, taskId: 'task', agentId: 'old-provider', status: 'EXITED' } as never)
        : currentLookup(id),
    );
    const result = await prepareTaskContextHandoff(input, f.deps);
    expect(result.sessionId).toBe('session');
    expect(result.relativePaths).toEqual(['agentterm-context/file.txt']);
    expect(f.exportToWorktree).toHaveBeenCalledWith(original, 'C:/task');
    expect(f.attachment).toEqual(original);
  });
  it.each(['missing', 'foreign'])(
    'rejects %s source-session provenance before exporting',
    async (source) => {
      const f = fixture();
      f.attachment.sessionId = 'previous';
      const currentLookup = f.deps.sessions.findById;
      vi.spyOn(f.deps.sessions, 'findById').mockImplementation(async (id) =>
        id === 'previous'
          ? ((source === 'missing'
              ? undefined
              : { id, taskId: 'other', status: 'EXITED' }) as never)
          : currentLookup(id),
      );
      await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
      expect(f.exportToWorktree).not.toHaveBeenCalled();
    },
  );
  it('rejects a foreign-task record even when returned by the task repository', async () => {
    const f = fixture();
    f.attachment.taskId = 'other';
    await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('validates every source session before exporting any file in a mixed batch', async () => {
    const f = fixture();
    const invalid = { ...f.attachment, id: 'second', sessionId: 'missing-source' };
    vi.spyOn(f.deps.repository, 'listByTaskId').mockResolvedValue([f.attachment, invalid]);
    const currentLookup = f.deps.sessions.findById;
    vi.spyOn(f.deps.sessions, 'findById').mockImplementation(async (id) =>
      id === 'missing-source' ? undefined : currentLookup(id),
    );
    await expect(
      prepareTaskContextHandoff({ ...input, attachmentIds: ['file', 'second'] }, f.deps),
    ).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('refuses a superseded destination even for valid historical context', async () => {
    const f = fixture();
    f.attachment.sessionId = 'previous';
    vi.spyOn(f.deps.sessions, 'listByTaskId').mockResolvedValue([{ id: 'newest' }] as never);
    await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('requires explicit worktree-copy consent for reused context', async () => {
    const f = fixture();
    f.attachment.sessionId = 'previous';
    await expect(
      prepareTaskContextHandoff({ ...input, confirmWorktreeCopy: false } as never, f.deps),
    ).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('refuses superseded sessions', async () => {
    const f = fixture();
    vi.spyOn(f.deps.sessions, 'listByTaskId').mockResolvedValue([{ id: 'newer' }] as never);
    await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('refuses absent worktrees and running quality gates', async () => {
    const f = fixture();
    vi.spyOn(f.deps.git, 'inspect').mockResolvedValue({ kind: 'missing' } as never);
    await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
    const g = fixture();
    vi.spyOn(g.deps.qualityGateRuns, 'listByTaskId').mockResolvedValue([
      { status: 'RUNNING' },
    ] as never);
    await expect(prepareTaskContextHandoff(input, g.deps)).rejects.toThrow();
    expect(g.exportToWorktree).not.toHaveBeenCalled();
  });
  it('exports only selected records and returns a prompt without sending terminal input', async () => {
    const f = fixture();
    expect(await prepareTaskContextHandoff(input, f.deps)).toMatchObject({
      sessionId: 'session',
      prompt: 'prompt',
      relativePaths: ['agentterm-context/file.txt'],
    });
    expect(f.exportToWorktree).toHaveBeenCalledWith(f.attachment, 'C:/task');
  });
  it('refuses a different task or missing selection before export', async () => {
    const f = fixture();
    await expect(
      prepareTaskContextHandoff({ ...input, taskId: 'other' }, f.deps),
    ).rejects.toThrow();
    await expect(
      prepareTaskContextHandoff({ ...input, attachmentIds: ['other'] }, f.deps),
    ).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('refuses unsupported adapters', async () => {
    const f = fixture();
    f.adapter.inspect = async () => ({ kind: 'available', capabilities: [] });
    await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
    expect(f.exportToWorktree).not.toHaveBeenCalled();
  });
  it('does not export binary context or oversized text', async () => {
    for (const change of [{ mime: 'image/png' }, { size: 65537 }]) {
      const f = fixture();
      Object.assign(f.attachment, change);
      await expect(prepareTaskContextHandoff(input, f.deps)).rejects.toThrow();
      expect(f.exportToWorktree).not.toHaveBeenCalled();
    }
  });
});
