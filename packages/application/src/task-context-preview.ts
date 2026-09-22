import type { TaskRepository } from './ports';
import {
  TaskContextError,
  type TaskContextAttachment,
  type TaskContextRepository,
} from './task-context';

export interface TaskContextTextReader {
  readText(record: TaskContextAttachment): Promise<string>;
}
export interface TaskContextPreview {
  readonly attachmentId: string;
  readonly text: string;
}
export interface TaskContextPreviewDependencies {
  readonly tasks: Pick<TaskRepository, 'findById'>;
  readonly repository: Pick<TaskContextRepository, 'listByTaskId'>;
  readonly reader: TaskContextTextReader;
}
export async function previewTaskContext(
  input: { readonly taskId: string; readonly attachmentId: string },
  deps: TaskContextPreviewDependencies,
): Promise<TaskContextPreview> {
  if (!(await deps.tasks.findById(input.taskId))) throw new TaskContextError('TARGET');
  const record = (await deps.repository.listByTaskId(input.taskId)).find(
    (item) => item.id === input.attachmentId,
  );
  if (!record || record.taskId !== input.taskId) throw new TaskContextError('TARGET');
  if (
    !Number.isInteger(record.size) ||
    record.size < 1 ||
    record.size > 65536 ||
    !['text/plain', 'text/markdown', 'application/json'].includes(record.mime)
  )
    throw new TaskContextError('TYPE');
  try {
    return { attachmentId: record.id, text: await deps.reader.readText(record) };
  } catch {
    throw new TaskContextError('READ_FAILED');
  }
}
