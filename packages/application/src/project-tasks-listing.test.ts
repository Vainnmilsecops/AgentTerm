import { describe, expect, it, vi } from 'vitest';

import { TaskPhase, type Task } from '@agentterm/domain';

import { EntityNotFoundError } from './errors';
import { listProjectTasks } from './project-tasks-listing';

function task(id: string, projectId: string): Task {
  return Object.freeze({
    id,
    phase: TaskPhase.BACKLOG,
    projectId,
    title: `Task ${id}`,
  });
}

describe('listProjectTasks', () => {
  it('throws when the project does not exist', async () => {
    const projects = { findById: vi.fn().mockResolvedValue(undefined) };
    const tasks = { listByProjectId: vi.fn() };
    await expect(listProjectTasks('missing', projects, tasks)).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
  });

  it('returns the project tasks', async () => {
    const projects = { findById: vi.fn().mockResolvedValue({ id: 'p1', name: 'P1' }) };
    const tasks = { listByProjectId: vi.fn().mockResolvedValue([task('t1', 'p1'), task('t2', 'p1')]) };
    const result = await listProjectTasks('p1', projects, tasks);
    expect(result.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(tasks.listByProjectId).toHaveBeenCalledWith('p1');
  });
});
