import { describe, expect, it, vi } from 'vitest';
import { previewTaskContext, type TaskContextPreviewDependencies } from './task-context-preview';

function fixture() {
  const record = {
    id: 'file',
    taskId: 'task',
    sessionId: 'old-session',
    name: 'note.md',
    mime: 'text/markdown',
    size: 12,
    digest: 'a'.repeat(64),
    createdAt: 1,
  };
  const readText = vi.fn(async () => 'Xin chào 👋');
  const deps = {
    tasks: { findById: async () => ({ id: 'task' }) },
    repository: { listByTaskId: async () => [record] },
    reader: { readText },
  } as unknown as TaskContextPreviewDependencies;
  return { record, readText, deps };
}
const input = { taskId: 'task', attachmentId: 'file' };
describe('saved context preview', () => {
  it('reads historical task context without requiring a live agent or changing metadata', async () => {
    const f = fixture();
    const original = { ...f.record };
    expect(await previewTaskContext(input, f.deps)).toEqual({
      attachmentId: 'file',
      text: 'Xin chào 👋',
    });
    expect(f.readText).toHaveBeenCalledWith(original);
    expect(f.record).toEqual(original);
  });
  it('refuses a missing task or attachment before reading bytes', async () => {
    const f = fixture();
    await expect(
      previewTaskContext({ ...input, attachmentId: 'absent' }, f.deps),
    ).rejects.toThrow();
    vi.spyOn(f.deps.tasks, 'findById').mockResolvedValue(undefined);
    await expect(previewTaskContext(input, f.deps)).rejects.toThrow();
    expect(f.readText).not.toHaveBeenCalled();
  });
  it('refuses a foreign-task attachment even if a repository returns it', async () => {
    const f = fixture();
    f.record.taskId = 'foreign';
    await expect(previewTaskContext(input, f.deps)).rejects.toThrow();
    expect(f.readText).not.toHaveBeenCalled();
  });
  it.each([{ size: 65537 }, { size: 0 }, { size: NaN }, { mime: 'application/pdf' }])(
    'rejects unsupported preview %j without reading',
    async (change) => {
      const f = fixture();
      Object.assign(f.record, change);
      await expect(previewTaskContext(input, f.deps)).rejects.toThrow();
      expect(f.readText).not.toHaveBeenCalled();
    },
  );
  it('sanitizes storage failures rather than exposing paths or content', async () => {
    const f = fixture();
    f.readText.mockRejectedValue(new Error('C:/private/secret.txt'));
    await expect(previewTaskContext(input, f.deps)).rejects.toThrow('CONTEXT_READ_FAILED');
  });
});
