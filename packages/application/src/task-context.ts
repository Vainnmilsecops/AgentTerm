import type { AgentSessionRepository, TaskRepository } from './ports';
import { serializeTaskWorkflow } from './task-workflow-serialization';

export interface TaskContextFile {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}
export interface TaskContextAttachment {
  readonly id: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly digest: string;
  readonly createdAt: number;
}
export interface TaskContextRepository {
  insertBatch(items: readonly TaskContextAttachment[]): Promise<void>;
  listByTaskId(taskId: string): Promise<readonly TaskContextAttachment[]>;
}
export interface TaskContextStore {
  put(
    taskId: string,
    file: TaskContextFile,
  ): Promise<Omit<TaskContextAttachment, 'taskId' | 'sessionId' | 'createdAt'>>;
}
export interface TaskContextDependencies {
  readonly tasks: Pick<TaskRepository, 'findById'>;
  readonly sessions: Pick<AgentSessionRepository, 'findById'>;
  readonly repository: TaskContextRepository;
  readonly store: TaskContextStore;
  readonly clock: () => number;
}
export class TaskContextError extends Error {
  constructor(code: 'TARGET' | 'LIMIT' | 'TYPE' | 'NAME' | 'SAVE_FAILED' | 'READ_FAILED') {
    super(`CONTEXT_${code}`);
    this.name = 'TaskContextError';
  }
}
export function validateContextBatch(files: readonly TaskContextFile[]): void {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 8 ||
    files.some(
      (file) =>
        !(file.bytes instanceof Uint8Array) ||
        file.bytes.byteLength < 1 ||
        file.bytes.byteLength > 8 * 1024 * 1024,
    ) ||
    files.reduce((total, file) => total + file.bytes.byteLength, 0) > 32 * 1024 * 1024
  )
    throw new TaskContextError('LIMIT');
}
export async function importTaskContext(
  input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly files: readonly TaskContextFile[];
  },
  deps: TaskContextDependencies,
): Promise<readonly TaskContextAttachment[]> {
  validateContextBatch(input.files);
  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await deps.tasks.findById(input.taskId);
    const session = await deps.sessions.findById(input.sessionId);
    if (!task || session?.taskId !== task.id) throw new TaskContextError('TARGET');
    if ((await deps.repository.listByTaskId(task.id)).length + input.files.length > 64)
      throw new TaskContextError('LIMIT');
    const items: TaskContextAttachment[] = [];
    try {
      for (const file of input.files) {
        const stored = await deps.store.put(task.id, file);
        items.push(
          Object.freeze({
            ...stored,
            taskId: task.id,
            sessionId: input.sessionId,
            createdAt: deps.clock(),
          }),
        );
      }
      await deps.repository.insertBatch(items);
      return Object.freeze(items);
    } catch (error) {
      // Files can survive failed metadata commits. Keep them private, never publish
      // partial success or delete unverified paths; the store bounds orphan count.
      if (error instanceof TaskContextError) throw error;
      throw new TaskContextError('SAVE_FAILED');
    }
  });
}
