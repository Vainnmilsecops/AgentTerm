import { describe, expect, it, vi } from 'vitest';

import type { Task, WorkspaceTaskOverview } from '@agentterm/application';

import {
  defaultDependencyDraft,
  describeDependencyAction,
  selectDependencyCandidates,
  validateDependencyDraft,
  type DependencyDraft,
} from './dependency-editor-state';

function task(id: string, projectId: string, title: string): Task {
  return Object.freeze({
    id,
    phase: 'BACKLOG' as Task['phase'],
    projectId,
    title,
  });
}

function overview(): WorkspaceTaskOverview {
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
    task: task('task-current', 'p1', 'Current'),
  }) as WorkspaceTaskOverview;
}

describe('defaultDependencyDraft', () => {
  it('returns an empty dependency draft for the current task', () => {
    const draft = defaultDependencyDraft(task('task-current', 'p1', 'Current'));
    expect(draft.taskId).toBe('task-current');
    expect(draft.dependencyTaskId).toBe('');
  });
});

describe('selectDependencyCandidates', () => {
  it('returns same-project tasks other than the current one', () => {
    const candidates = selectDependencyCandidates(task('task-current', 'p1', 'Current'), [
      task('task-a', 'p1', 'A'),
      task('task-current', 'p1', 'Current'),
      task('task-b', 'p2', 'B'),
      task('task-c', 'p1', 'C'),
    ]);
    expect(candidates.map(({ task: t }) => t.id)).toEqual(['task-a', 'task-c']);
  });

  it('returns an empty list when there are no other same-project tasks', () => {
    expect(
      selectDependencyCandidates(task('task-current', 'p1', 'Current'), [
        task('task-current', 'p1', 'Current'),
        task('task-b', 'p2', 'B'),
      ]),
    ).toEqual([]);
  });
});

describe('validateDependencyDraft', () => {
  const baseDraft = (overrides: Partial<DependencyDraft> = {}): DependencyDraft => ({
    dependencyTaskId: 'task-a',
    taskId: 'task-current',
    ...overrides,
  });

  it('rejects empty dependency selection', () => {
    expect(validateDependencyDraft(baseDraft({ dependencyTaskId: '' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects self-dependency', () => {
    expect(validateDependencyDraft(baseDraft({ dependencyTaskId: 'task-current' }))).toMatchObject({
      ok: false,
    });
  });

  it('rejects unknown task identity', () => {
    expect(validateDependencyDraft(baseDraft({ dependencyTaskId: 'BAD ID' }))).toMatchObject({
      ok: false,
    });
  });

  it('accepts a valid same-project dependency', () => {
    expect(validateDependencyDraft(baseDraft())).toEqual({ ok: true });
  });
});

describe('describeDependencyAction', () => {
  it('summarises add vs remove with the required task title', () => {
    expect(describeDependencyAction('add', { title: 'Setup CI' })).toContain('Setup CI');
    expect(describeDependencyAction('remove', { title: 'Setup CI' })).toContain('Setup CI');
  });
});

describe('dependency-editor state smoke', () => {
  it('imports without errors', async () => {
    const module = await import('./dependency-editor-state');
    expect(module.defaultDependencyDraft).toBeTypeOf('function');
    vi.restoreAllMocks();
  });
  it('produces an overview for fixtures', () => {
    expect(overview().task.id).toBe('task-current');
  });
});
