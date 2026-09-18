import { describe, expect, it } from 'vitest';
import { importTaskContext, type TaskContextDependencies } from './task-context';

const input = {
  taskId: 'task',
  sessionId: 'session',
  files: [{ name: 'note.txt', mime: 'text/plain', bytes: new Uint8Array([65]) }],
};
function fixture() {
  const stored: unknown[] = [];
  const rows: unknown[] = [];
  const deps = {
    tasks: { findById: async () => ({ id: 'task' }) },
    sessions: { findById: async () => ({ taskId: 'task' }) },
    repository: {
      listByTaskId: async () => [],
      insertBatch: async (items: unknown[]) => {
        rows.push(...items);
      },
    },
    store: {
      put: async () => {
        stored.push(true);
        return { id: 'id', name: 'note.txt', mime: 'text/plain', size: 10, digest: 'a'.repeat(64) };
      },
    },
    clock: () => 42,
  } as unknown as TaskContextDependencies;
  return { deps, stored, rows };
}
describe('task context import', () => {
  it('associates immutable metadata with the confirmed task and session', async () => {
    const f = fixture();
    const result = await importTaskContext(input, f.deps);
    expect(result[0]).toMatchObject({
      taskId: 'task',
      sessionId: 'session',
      createdAt: 42,
      mime: 'text/plain',
    });
    expect(f.rows).toEqual(result);
  });
  it('refuses a session from another task before writing files', async () => {
    const f = fixture();
    f.deps.sessions.findById = async () => ({ taskId: 'other' }) as never;
    await expect(importTaskContext(input, f.deps)).rejects.toThrow('TARGET');
    expect(f.stored).toEqual([]);
  });
  it('rejects oversized batches before writing any file', async () => {
    const f = fixture();
    await expect(
      importTaskContext({ ...input, files: Array(9).fill(input.files[0]) }, f.deps),
    ).rejects.toThrow('LIMIT');
    expect(f.stored).toEqual([]);
  });
  it('does not report success if metadata persistence fails', async () => {
    const f = fixture();
    f.deps.repository.insertBatch = async () => {
      throw new Error('private database detail');
    };
    await expect(importTaskContext(input, f.deps)).rejects.toThrow('SAVE_FAILED');
    expect(f.rows).toEqual([]);
  });
});
