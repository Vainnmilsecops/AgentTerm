import { describe, expect, it, vi } from 'vitest';

import {
  ExecutionArtifactKindValue,
  TaskPhase,
  type AgentSessionSummary,
  type ExecutionArtifact,
  type Task,
  type WorkspaceTaskOverview,
} from '@agentterm/application';

import {
  defaultArtifactDraft,
  selectArtifactKindForPhase,
  validateArtifactDraft,
  type ArtifactDraft,
} from './artifact-producer-state';

const task: Task = Object.freeze({
  id: 'task-1',
  phase: TaskPhase.PLANNING,
  projectId: 'project-1',
  title: 'Test Task',
});

const session: AgentSessionSummary = Object.freeze({
  agentId: 'codex',
  createdAt: 1,
  endedAt: undefined,
  failureCode: undefined,
  id: 'session-1',
  status: 'WORKING',
  taskId: task.id,
});

function overview(overrides: Partial<WorkspaceTaskOverview> = {}): WorkspaceTaskOverview {
  return Object.freeze({
    activeSession: undefined,
    artifacts: Object.freeze([]),
    canAcceptPlan: false,
    canApproveReview: false,
    canBeginPlanning: false,
    canRequestChanges: false,
    canRequestReview: false,
    canRetryExecution: false,
    canRevisePlan: false,
    canRunQualityGate: false,
    canStartExecution: false,
    canStartPlanning: false,
    blocked: false,
    dependencies: Object.freeze([]),
    latestPlan: undefined,
    latestReview: undefined,
    latestSession: undefined,
    previousSession: undefined,
    qualityGateRuns: Object.freeze([]),
    reviewHistory: Object.freeze([]),
    task,
    ...overrides,
  }) as WorkspaceTaskOverview;
}

describe('defaultArtifactDraft', () => {
  it('returns a planning draft with the plan heading', () => {
    const draft = defaultArtifactDraft(task, ExecutionArtifactKindValue.PLAN);
    expect(draft.kind).toBe(ExecutionArtifactKindValue.PLAN);
    expect(draft.content).toBe('# Plan\n\n');
    expect(draft.sessionId).toBeUndefined();
  });

  it('returns an execution-summary draft with the execution summary heading', () => {
    const draft = defaultArtifactDraft(
      { ...task, phase: TaskPhase.RUNNING },
      ExecutionArtifactKindValue.EXECUTION_SUMMARY,
    );
    expect(draft.kind).toBe(ExecutionArtifactKindValue.EXECUTION_SUMMARY);
    expect(draft.content).toBe('# Execution Summary\n\n');
  });

  it('returns a review draft bound to the active session when provided', () => {
    const draft = defaultArtifactDraft(
      { ...task, phase: TaskPhase.REVIEW },
      ExecutionArtifactKindValue.REVIEW,
      session.id,
    );
    expect(draft.kind).toBe(ExecutionArtifactKindValue.REVIEW);
    expect(draft.content).toBe('# Review\n\n');
    expect(draft.sessionId).toBe(session.id);
  });
});

describe('selectArtifactKindForPhase', () => {
  it('returns the canonical kind for each phase', () => {
    expect(selectArtifactKindForPhase(TaskPhase.PLANNING)).toBe(ExecutionArtifactKindValue.PLAN);
    expect(selectArtifactKindForPhase(TaskPhase.RUNNING)).toBe(
      ExecutionArtifactKindValue.EXECUTION_SUMMARY,
    );
    expect(selectArtifactKindForPhase(TaskPhase.REVIEW)).toBe(ExecutionArtifactKindValue.REVIEW);
    expect(selectArtifactKindForPhase(TaskPhase.BACKLOG)).toBe(ExecutionArtifactKindValue.PLAN);
    expect(selectArtifactKindForPhase(TaskPhase.DONE)).toBe(ExecutionArtifactKindValue.REVIEW);
  });
});

describe('validateArtifactDraft', () => {
  const baseDraft = (): ArtifactDraft => ({
    content: '# Plan\n\nSome concrete steps.',
    id: 'artifact-1',
    kind: ExecutionArtifactKindValue.PLAN,
    sessionId: undefined,
    taskId: task.id,
  });

  it('rejects content that is missing the heading', () => {
    const result = validateArtifactDraft({ ...baseDraft(), content: 'No heading here.' });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects content without a non-empty body after the heading', () => {
    const result = validateArtifactDraft({ ...baseDraft(), content: '# Plan\n\n   ' });
    expect(result).toMatchObject({ ok: false });
  });

  it('accepts content that begins with the heading and has a body', () => {
    const result = validateArtifactDraft(baseDraft());
    expect(result).toEqual({ ok: true });
  });

  it('rejects draft with mismatched kind heading', () => {
    const result = validateArtifactDraft({
      ...baseDraft(),
      content: '# Review\n\nbody',
      kind: ExecutionArtifactKindValue.PLAN,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects content that exceeds 1 MiB', () => {
    const long = `${'# Plan\n\n'}${'x'.repeat(1_048_577)}`;
    const result = validateArtifactDraft({ ...baseDraft(), content: long });
    expect(result).toMatchObject({ ok: false });
  });
});

describe('artifact-producer smoke', () => {
  it('imports without circular reference issues', async () => {
    const module = await import('./artifact-producer-state');
    expect(module.defaultArtifactDraft).toBeTypeOf('function');
    vi.restoreAllMocks();
  });
});

// Keep the unused imports referenced for compiler strictness.
const _artifact: ExecutionArtifact = Object.freeze({
  canonicalName: 'planning/plan.md',
  content: '# Plan\n\n',
  createdAt: 1,
  format: 'markdown',
  id: 'x',
  kind: ExecutionArtifactKindValue.PLAN,
  phase: TaskPhase.PLANNING,
  schemaVersion: 1,
  sessionId: undefined,
  taskId: 'task-1',
  validation: 'VALID',
});
void _artifact;
void overview;
