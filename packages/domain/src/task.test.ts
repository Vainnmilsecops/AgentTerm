import { describe, expect, it } from 'vitest';

import {
  createTask,
  InvalidTaskPhaseTransitionError,
  TaskPhase,
  transitionTask,
  type Task,
  type TaskPhase as TaskPhaseValue,
} from './index';

const validTaskInput = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Build the domain foundation',
};

function taskAtPhase(targetPhase: TaskPhaseValue): Task {
  let task = createTask(validTaskInput);
  const progression = [
    TaskPhase.PLANNING,
    TaskPhase.RUNNING,
    TaskPhase.REVIEW,
    TaskPhase.DONE,
  ] as const;

  for (const phase of progression) {
    if (task.phase === targetPhase) {
      return task;
    }

    task = transitionTask(task, phase);
  }

  return task;
}

describe('createTask', () => {
  it('places a new task in BACKLOG', () => {
    expect(createTask(validTaskInput)).toEqual({
      ...validTaskInput,
      phase: TaskPhase.BACKLOG,
    });
  });

  it.each([
    { ...validTaskInput, id: '' },
    { ...validTaskInput, id: '   ' },
    { ...validTaskInput, projectId: '' },
    { ...validTaskInput, projectId: '   ' },
    { ...validTaskInput, title: '' },
    { ...validTaskInput, title: '   ' },
  ])('rejects blank task identity data', (input) => {
    expect(() => createTask(input)).toThrow(TypeError);
  });
});

describe('transitionTask', () => {
  it('advances through the primary task lifecycle one phase at a time', () => {
    const backlog = createTask(validTaskInput);
    const planning = transitionTask(backlog, TaskPhase.PLANNING);
    const running = transitionTask(planning, TaskPhase.RUNNING);
    const review = transitionTask(running, TaskPhase.REVIEW);
    const done = transitionTask(review, TaskPhase.DONE);

    expect([backlog.phase, planning.phase, running.phase, review.phase, done.phase]).toEqual([
      'BACKLOG',
      'PLANNING',
      'RUNNING',
      'REVIEW',
      'DONE',
    ]);
  });

  it('returns a transitioned task without changing the prior task state', () => {
    const backlog = createTask(validTaskInput);

    const planning = transitionTask(backlog, TaskPhase.PLANNING);

    expect(backlog.phase).toBe(TaskPhase.BACKLOG);
    expect(planning).toEqual({ ...backlog, phase: TaskPhase.PLANNING });
    expect(planning).not.toBe(backlog);
  });

  it('moves a reviewed Task back to RUNNING when changes are requested', () => {
    const running = taskAtPhase(TaskPhase.RUNNING);
    const review = transitionTask(running, TaskPhase.REVIEW);

    const resumed = transitionTask(review, TaskPhase.RUNNING);

    expect(resumed.phase).toBe(TaskPhase.RUNNING);
    expect(review.phase).toBe(TaskPhase.REVIEW);
  });

  it.each([
    [TaskPhase.BACKLOG, TaskPhase.BACKLOG],
    [TaskPhase.BACKLOG, TaskPhase.RUNNING],
    [TaskPhase.BACKLOG, TaskPhase.REVIEW],
    [TaskPhase.BACKLOG, TaskPhase.DONE],
    [TaskPhase.PLANNING, TaskPhase.BACKLOG],
    [TaskPhase.PLANNING, TaskPhase.PLANNING],
    [TaskPhase.PLANNING, TaskPhase.REVIEW],
    [TaskPhase.PLANNING, TaskPhase.DONE],
    [TaskPhase.RUNNING, TaskPhase.BACKLOG],
    [TaskPhase.RUNNING, TaskPhase.PLANNING],
    [TaskPhase.RUNNING, TaskPhase.RUNNING],
    [TaskPhase.RUNNING, TaskPhase.DONE],
    [TaskPhase.REVIEW, TaskPhase.BACKLOG],
    [TaskPhase.REVIEW, TaskPhase.PLANNING],
    [TaskPhase.REVIEW, TaskPhase.REVIEW],
    [TaskPhase.DONE, TaskPhase.BACKLOG],
    [TaskPhase.DONE, TaskPhase.PLANNING],
    [TaskPhase.DONE, TaskPhase.RUNNING],
    [TaskPhase.DONE, TaskPhase.REVIEW],
    [TaskPhase.DONE, TaskPhase.DONE],
  ])('rejects an invalid %s -> %s transition', (from, to) => {
    const task = taskAtPhase(from);

    let caughtError: unknown;
    try {
      transitionTask(task, to);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(InvalidTaskPhaseTransitionError);
    expect(caughtError).toMatchObject({ from, to });
    expect(task.phase).toBe(from);
  });
});
