import { describe, expect, it, vi } from 'vitest';

import type {
  AgentSession,
  ExecutionArtifact,
  QualityGateRun,
  Task,
  TaskReview,
  TaskTransitionAudit,
} from '@agentterm/domain';

import { EntityNotFoundError } from './errors';
import { loadTaskActivity, type TaskActivityDependencies } from './task-activity';
import type { TaskPullRequest } from './ports';

const task: Task = { id: 'task-1', projectId: 'project-1', title: 'Timeline', phase: 'REVIEW' };

function dependencies(
  overrides: Partial<{
    sessions: readonly AgentSession[];
    artifacts: readonly ExecutionArtifact[];
    gates: readonly QualityGateRun[];
    reviews: readonly TaskReview[];
    transitions: readonly TaskTransitionAudit[];
    pullRequests: readonly TaskPullRequest[];
    task: Task | undefined;
  }> = {},
): TaskActivityDependencies {
  return {
    tasks: {
      findById: vi.fn(async () => overrides.task ?? task),
    } as unknown as TaskActivityDependencies['tasks'],
    sessions: {
      listByTaskId: vi.fn(async () => overrides.sessions ?? []),
    } as unknown as TaskActivityDependencies['sessions'],
    artifacts: {
      listByTaskId: vi.fn(async () => overrides.artifacts ?? []),
    } as unknown as TaskActivityDependencies['artifacts'],
    qualityGateRuns: {
      listByTaskId: vi.fn(async () => overrides.gates ?? []),
    } as unknown as TaskActivityDependencies['qualityGateRuns'],
    reviews: {
      listByTaskId: vi.fn(async () => overrides.reviews ?? []),
    } as unknown as TaskActivityDependencies['reviews'],
    taskTransitions: {
      listByTaskId: vi.fn(async () => overrides.transitions ?? []),
    } as unknown as TaskActivityDependencies['taskTransitions'],
    pullRequests: {
      listByTaskId: vi.fn(async () => overrides.pullRequests ?? []),
    } as unknown as TaskActivityDependencies['pullRequests'],
  };
}

describe('loadTaskActivity', () => {
  it('combines persisted evidence in deterministic newest-first order without exposing content or output', async () => {
    const session = {
      id: 'session-1',
      taskId: task.id,
      agentId: 'codex',
      createdAt: 10,
      providerSessionId: 'private-provider-id',
      history: [
        { kind: 'START_REQUESTED', occurredAt: 10, sequence: 1, status: 'STARTING' },
        { kind: 'STOP_REQUESTED', occurredAt: 25, sequence: 2, status: 'WORKING' },
        {
          kind: 'PROCESS_EXITED',
          occurredAt: 30,
          sequence: 3,
          status: 'EXITED',
          reason: 'STOPPED',
          exitCode: 0,
        },
      ],
    } as unknown as AgentSession;
    const artifact = {
      id: 'artifact-1',
      taskId: task.id,
      kind: 'plan',
      phase: 'PLANNING',
      sessionId: 'session-1',
      createdAt: 15,
      content: 'TOKEN=secret',
      canonicalName: 'planning/plan.md',
    } as ExecutionArtifact;
    const gate = {
      id: 'gate-run-1',
      taskId: task.id,
      gate: { id: 'lint', kind: 'LINT' },
      startedAt: 20,
      finishedAt: 22,
      status: 'FAILED',
      output: { text: 'TOKEN=secret', reference: 'C:\\private\\log', truncated: false },
      worktree: { worktreePath: 'C:\\private\\repo' },
    } as QualityGateRun;
    const review = {
      id: 'review-1',
      taskId: task.id,
      requestedAt: 24,
      decidedAt: 27,
      status: 'CHANGES_REQUESTED',
      decisionNote: 'TOKEN=secret',
    } as TaskReview;
    const transition = {
      id: 'transition-1',
      taskId: task.id,
      fromPhase: 'PLANNING',
      toPhase: 'RUNNING',
      trigger: 'manual',
      createdAt: 18,
      artifactId: 'artifact-1',
    } as TaskTransitionAudit;
    const pullRequest = {
      taskId: task.id,
      provider: 'github',
      repositoryOwner: 'org',
      repositoryName: 'repo',
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
      title: 'secret title',
      status: 'OPEN',
      draft: true,
      checks: { state: 'PENDING' },
      reviewState: 'NONE',
      createdAt: 21,
      updatedAt: 28,
      lastSyncedAt: 29,
    } as TaskPullRequest;

    const result = await loadTaskActivity(
      task.id,
      dependencies({
        sessions: [session],
        artifacts: [artifact],
        gates: [gate],
        reviews: [review],
        transitions: [transition],
        pullRequests: [pullRequest],
      }),
    );

    expect(result.taskId).toBe(task.id);
    expect(result.items.map(({ kind, occurredAt }) => [kind, occurredAt])).toEqual([
      ['SESSION_EXITED', 30],
      ['PULL_REQUEST_SNAPSHOT', 29],
      ['REVIEW_DECIDED', 27],
      ['SESSION_STOP_REQUESTED', 25],
      ['REVIEW_REQUESTED', 24],
      ['QUALITY_GATE', 22],
      ['PHASE_TRANSITION', 18],
      ['ARTIFACT', 15],
      ['SESSION_STARTED', 10],
    ]);
    expect(result.items).toContainEqual(
      expect.objectContaining({
        kind: 'SESSION_STARTED',
        agentId: 'codex',
        attempt: 1,
        sessionId: 'session-1',
      }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        kind: 'ARTIFACT',
        artifactId: 'artifact-1',
        sessionId: 'session-1',
      }),
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        kind: 'PULL_REQUEST_SNAPSHOT',
        number: 42,
        observedAt: 29,
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/secret|C:\\\\private|provider-id/);
  });

  it('keeps every attempt and uses stable event order for timestamp ties', async () => {
    const sessions = ['session-1', 'session-2'].map((id) => ({
      id,
      taskId: task.id,
      agentId: id === 'session-1' ? 'codex' : 'claude',
      createdAt: 10,
      history: [{ kind: 'START_REQUESTED', occurredAt: 10, sequence: 1, status: 'STARTING' }],
    })) as unknown as AgentSession[];
    const result = await loadTaskActivity(task.id, dependencies({ sessions }));
    expect(result.items).toEqual([
      expect.objectContaining({ kind: 'SESSION_STARTED', sessionId: 'session-2', attempt: 2 }),
      expect.objectContaining({ kind: 'SESSION_STARTED', sessionId: 'session-1', attempt: 1 }),
    ]);
  });

  it('shows a provider conversation continuation only when two saved attempts share its identity', async () => {
    const sessions = ['session-1', 'session-2'].map((id, index) => ({
      id,
      taskId: task.id,
      agentId: 'codex',
      createdAt: 10 + index,
      providerSessionId: 'opaque-private-id',
      history: [
        { kind: 'START_REQUESTED', occurredAt: 10 + index, sequence: 1, status: 'STARTING' },
      ],
    })) as unknown as AgentSession[];
    const result = await loadTaskActivity(task.id, dependencies({ sessions }));
    expect(result.items[0]).toMatchObject({
      kind: 'SESSION_STARTED',
      sessionId: 'session-2',
      continuedFromSessionId: 'session-1',
    });
    expect(result.items[1]).toMatchObject({
      kind: 'SESSION_STARTED',
      sessionId: 'session-1',
      continuedFromSessionId: undefined,
    });
    expect(JSON.stringify(result)).not.toContain('opaque-private-id');
  });

  it('rejects a missing Task before reading its histories', async () => {
    const deps = dependencies();
    deps.tasks.findById = vi.fn(async () => undefined);
    await expect(loadTaskActivity('missing', deps)).rejects.toEqual(
      new EntityNotFoundError('Task', 'missing'),
    );
    expect(deps.sessions.listByTaskId).not.toHaveBeenCalled();
  });

  it('fails closed if a history reader returns evidence for a different Task', async () => {
    const foreign = {
      id: 'foreign-artifact',
      taskId: 'task-2',
      kind: 'plan',
      phase: 'PLANNING',
      sessionId: undefined,
      createdAt: 5,
      content: 'private context',
    } as ExecutionArtifact;
    await expect(loadTaskActivity(task.id, dependencies({ artifacts: [foreign] }))).rejects.toThrow(
      'Task activity history is inconsistent.',
    );
  });
});
