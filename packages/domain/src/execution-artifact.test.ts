import { describe, expect, it } from 'vitest';

import { createExecutionArtifact, ExecutionArtifactKind, TaskPhase } from './index';

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
});
