const taskWorkflowOperationTails = new Map<string, Promise<void>>();

/** Serializes in-process Task workflow admissions that can enable or stop code writers. */
export async function serializeTaskWorkflow<Result>(
  taskId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const predecessor = taskWorkflowOperationTails.get(taskId) ?? Promise.resolve();
  let release = (): void => undefined;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => completion);
  taskWorkflowOperationTails.set(taskId, tail);
  await predecessor;

  try {
    return await operation();
  } finally {
    release();
    if (taskWorkflowOperationTails.get(taskId) === tail) {
      taskWorkflowOperationTails.delete(taskId);
    }
  }
}
