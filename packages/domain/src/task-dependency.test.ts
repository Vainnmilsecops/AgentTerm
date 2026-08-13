import { describe, expect, it } from 'vitest';

import { createTaskDependency, validateTaskDependencyAddition, type TaskDependency } from './index';

describe('Task Dependency', () => {
  it('rejects a Task depending on itself', () => {
    expect(() => createTaskDependency({ dependencyTaskId: 'task-a', taskId: 'task-a' })).toThrow(
      expect.objectContaining({ name: 'InvalidTaskDependencyError', reason: 'SELF' }),
    );
  });

  it('rejects a duplicate dependency edge', () => {
    const dependency = createTaskDependency({ dependencyTaskId: 'task-b', taskId: 'task-a' });

    expect(() => validateTaskDependencyAddition([dependency], dependency)).toThrow(
      expect.objectContaining({ name: 'InvalidTaskDependencyError', reason: 'DUPLICATE' }),
    );
  });

  it('rejects an edge that closes a transitive dependency cycle', () => {
    const graph: readonly TaskDependency[] = [
      createTaskDependency({ dependencyTaskId: 'task-b', taskId: 'task-a' }),
      createTaskDependency({ dependencyTaskId: 'task-c', taskId: 'task-b' }),
    ];
    const closingEdge = createTaskDependency({ dependencyTaskId: 'task-a', taskId: 'task-c' });

    expect(() => validateTaskDependencyAddition(graph, closingEdge)).toThrow(
      expect.objectContaining({ name: 'InvalidTaskDependencyError', reason: 'CYCLE' }),
    );
  });

  it('accepts a deterministic acyclic edge', () => {
    const graph: readonly TaskDependency[] = [
      createTaskDependency({ dependencyTaskId: 'task-b', taskId: 'task-a' }),
    ];
    const dependency = createTaskDependency({ dependencyTaskId: 'task-c', taskId: 'task-a' });

    expect(validateTaskDependencyAddition(graph, dependency)).toBe(dependency);
  });
});
