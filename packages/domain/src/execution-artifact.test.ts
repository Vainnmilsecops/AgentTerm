import { describe, expect, it } from 'vitest';

import {
  createExecutionArtifact,
  ExecutionArtifactKind,
  isDynamicPhaseArtifactKind,
  TaskPhase,
} from './index';

describe('ExecutionArtifact', () => {
  it.each([
    {
      canonicalName: 'planning/plan.md',
      content: '# Plan\n\n- Inspect the existing implementation.',
      kind: ExecutionArtifactKind.PLAN,
      phase: TaskPhase.PLANNING,
    },
    {
      canonicalName: 'running/execution-summary.md',
      content: '# Execution Summary\n\nImplemented artifact history.',
      kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
      phase: TaskPhase.RUNNING,
    },
    {
      canonicalName: 'review/review.md',
      content: '# Review\n\nNo blocking findings.',
      kind: ExecutionArtifactKind.REVIEW,
      phase: TaskPhase.REVIEW,
    },
  ])('creates a validated $kind contract with immutable provenance', (example) => {
    const artifact = createExecutionArtifact({
      content: example.content,
      createdAt: 1_723_456_789_000,
      id: `artifact-${example.kind}`,
      kind: example.kind,
      sessionId: 'session-1',
      taskId: 'task-1',
    });

    expect(artifact).toEqual({
      canonicalName: example.canonicalName,
      content: example.content,
      createdAt: 1_723_456_789_000,
      format: 'markdown',
      id: `artifact-${example.kind}`,
      kind: example.kind,
      phase: example.phase,
      schemaVersion: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      validation: 'VALID',
    });
    expect(Object.isFrozen(artifact)).toBe(true);
  });

  it('supports a Task-level artifact without inventing an Agent Session', () => {
    const artifact = createExecutionArtifact({
      content: '# Plan\n\nKế hoạch do người dùng tạo.',
      createdAt: 10,
      id: 'artifact-task-level',
      kind: ExecutionArtifactKind.PLAN,
      taskId: 'task-1',
    });

    expect(artifact.sessionId).toBeUndefined();
  });

  it.each([
    { content: '# Plan', kind: ExecutionArtifactKind.PLAN },
    { content: '# Wrong\n\nBody', kind: ExecutionArtifactKind.PLAN },
    { content: '# Execution Summary\n\n\0secret', kind: ExecutionArtifactKind.EXECUTION_SUMMARY },
  ])('rejects malformed content for $kind', ({ content, kind }) => {
    expect(() =>
      createExecutionArtifact({
        content,
        createdAt: 10,
        id: 'artifact-1',
        kind,
        taskId: 'task-1',
      }),
    ).toThrow(TypeError);
  });

  it.each([
    { field: 'id', value: ' ' },
    { field: 'taskId', value: '' },
    { field: 'sessionId', value: '\t' },
  ])('rejects blank $field provenance', ({ field, value }) => {
    expect(() =>
      createExecutionArtifact({
        content: '# Review\n\nLooks good.',
        createdAt: 10,
        id: field === 'id' ? value : 'artifact-1',
        kind: ExecutionArtifactKind.REVIEW,
        sessionId: field === 'sessionId' ? value : 'session-1',
        taskId: field === 'taskId' ? value : 'task-1',
      }),
    ).toThrow(TypeError);
  });

  describe('dynamic-phase brainstorm/sweep artifacts', () => {
    it('exposes brainstorm and sweep in the dynamic-phase kind set', () => {
      expect(isDynamicPhaseArtifactKind(ExecutionArtifactKind.BRAINSTORM)).toBe(true);
      expect(isDynamicPhaseArtifactKind(ExecutionArtifactKind.SWEEP)).toBe(true);
      expect(isDynamicPhaseArtifactKind(ExecutionArtifactKind.RESEARCH)).toBe(false);
      expect(isDynamicPhaseArtifactKind(ExecutionArtifactKind.PLAN)).toBe(false);
    });

    it('creates a brainstorm artifact with a per-task canonical name', () => {
      const artifact = createExecutionArtifact({
        content: '# Brainstorm\n\nTry a row-level lock instead of a Task-wide lock.',
        createdAt: 1_700_000_000_000,
        id: 'artifact-brainstorm-1',
        kind: ExecutionArtifactKind.BRAINSTORM,
        phase: TaskPhase.PLANNING,
        sessionId: 'session-1',
        taskId: 'task-7',
      });
      expect(artifact).toMatchObject({
        canonicalName: 'brainstorm/task-7-session-1-1700000000000.md',
        kind: ExecutionArtifactKind.BRAINSTORM,
        phase: TaskPhase.PLANNING,
        sessionId: 'session-1',
        validation: 'VALID',
      });
    });

    it('creates a sweep artifact with a per-task canonical name', () => {
      const artifact = createExecutionArtifact({
        content: '# Sweep\n\nFinal notes before close.',
        createdAt: 1_700_000_000_500,
        id: 'artifact-sweep-1',
        kind: ExecutionArtifactKind.SWEEP,
        phase: TaskPhase.REVIEW,
        sessionId: 'session-2',
        taskId: 'task-9',
      });
      expect(artifact.canonicalName).toBe('sweep/task-9-session-2-1700000000500.md');
      expect(artifact.phase).toBe(TaskPhase.REVIEW);
    });

    it('refuses a brainstorm artifact without a session id', () => {
      expect(() =>
        createExecutionArtifact({
          content: '# Brainstorm\n\nBody.',
          createdAt: 1,
          id: 'artifact-b1',
          kind: ExecutionArtifactKind.BRAINSTORM,
          phase: TaskPhase.PLANNING,
          taskId: 'task-1',
        }),
      ).toThrow(TypeError);
    });

    it('refuses a brainstorm artifact without an explicit phase', () => {
      expect(() =>
        createExecutionArtifact({
          content: '# Brainstorm\n\nBody.',
          createdAt: 1,
          id: 'artifact-b2',
          kind: ExecutionArtifactKind.BRAINSTORM,
          sessionId: 'session-1',
          taskId: 'task-1',
        }),
      ).toThrow(TypeError);
    });

    it('refuses a static-kind artifact with an inconsistent phase override', () => {
      expect(() =>
        createExecutionArtifact({
          content: '# Plan\n\nBody.',
          createdAt: 1,
          id: 'artifact-plan-mismatch',
          kind: ExecutionArtifactKind.PLAN,
          phase: TaskPhase.RUNNING,
          sessionId: 'session-1',
          taskId: 'task-1',
        }),
      ).toThrow(TypeError);
    });

    it('accepts a static-kind artifact when phase matches the contract', () => {
      const artifact = createExecutionArtifact({
        content: '# Plan\n\nBody.',
        createdAt: 1,
        id: 'artifact-plan-ok',
        kind: ExecutionArtifactKind.PLAN,
        phase: TaskPhase.PLANNING,
        sessionId: 'session-1',
        taskId: 'task-1',
      });
      expect(artifact.phase).toBe(TaskPhase.PLANNING);
    });
  });
});
