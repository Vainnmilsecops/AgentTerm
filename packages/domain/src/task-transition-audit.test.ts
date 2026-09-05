import { describe, expect, it } from 'vitest';

import {
  TaskPhase,
  TaskTransitionTrigger,
  createTaskTransitionAudit,
} from './index';

describe('Task Transition Audit', () => {
  it('creates a frozen, append-only record for a manual phase change', () => {
    const audit = createTaskTransitionAudit({
      createdAt: 1_700_000_000_000,
      fromPhase: TaskPhase.PLANNING,
      id: 'audit-1',
      taskId: 'task-1',
      toPhase: TaskPhase.RUNNING,
      trigger: TaskTransitionTrigger.MANUAL,
    });

    expect(audit).toEqual({
      artifactId: undefined,
      createdAt: 1_700_000_000_000,
      fromPhase: 'PLANNING',
      id: 'audit-1',
      taskId: 'task-1',
      toPhase: 'RUNNING',
      trigger: 'manual',
    });
    expect(Object.isFrozen(audit)).toBe(true);
  });

  it('accepts the RESEARCH_AUTO_ADVANCE trigger for BACKLOG -> PLANNING with artifact id', () => {
    const audit = createTaskTransitionAudit({
      artifactId: 'artifact-1',
      createdAt: 1_700_000_000_000,
      fromPhase: TaskPhase.BACKLOG,
      id: 'audit-1',
      taskId: 'task-1',
      toPhase: TaskPhase.PLANNING,
      trigger: TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE,
    });

    expect(audit.trigger).toBe('research-auto-advance');
    expect(audit.artifactId).toBe('artifact-1');
  });

  it.each([
    [
      'rejects same-phase transitions',
      {
        artifactId: 'artifact-1',
        createdAt: 1,
        fromPhase: TaskPhase.PLANNING,
        id: 'a',
        taskId: 't',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.MANUAL,
      },
    ],
    [
      'rejects RESEARCH_AUTO_ADVANCE without an artifact id',
      {
        createdAt: 1,
        fromPhase: TaskPhase.BACKLOG,
        id: 'a',
        taskId: 't',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE,
      },
    ],
    [
      'rejects RESEARCH_AUTO_ADVANCE on a non-BACKLOG -> PLANNING edge',
      {
        artifactId: 'artifact-1',
        createdAt: 1,
        fromPhase: TaskPhase.RUNNING,
        id: 'a',
        taskId: 't',
        toPhase: TaskPhase.REVIEW,
        trigger: TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE,
      },
    ],
    [
      'rejects blank ids',
      {
        createdAt: 1,
        fromPhase: TaskPhase.PLANNING,
        id: '   ',
        taskId: 't',
        toPhase: TaskPhase.RUNNING,
        trigger: TaskTransitionTrigger.MANUAL,
      },
    ],
    [
      'rejects negative timestamps',
      {
        artifactId: 'artifact-1',
        createdAt: -1,
        fromPhase: TaskPhase.BACKLOG,
        id: 'a',
        taskId: 't',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE,
      },
    ],
    [
      'rejects unknown phase values',
      {
        artifactId: 'artifact-1',
        createdAt: 1,
        fromPhase: 'UNKNOWN' as unknown as TaskPhase,
        id: 'a',
        taskId: 't',
        toPhase: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.MANUAL,
      },
    ],
    [
      'rejects unsupported triggers',
      {
        artifactId: 'artifact-1',
        createdAt: 1,
        fromPhase: TaskPhase.BACKLOG,
        id: 'a',
        taskId: 't',
        toPhase: TaskPhase.PLANNING,
        trigger: 'auto-magic' as unknown as TaskTransitionTrigger,
      },
    ],
  ] as const)('%s', (_label, input) => {
    expect(() => createTaskTransitionAudit(input as never)).toThrow(TypeError);
  });
});
