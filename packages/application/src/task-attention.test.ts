import { describe, expect, it } from 'vitest';
import type {
  AgentWorkspaceOverview,
  QualityGateRunSummary,
  WorkspaceTaskOverview,
} from './workspace-overview';
import { deriveTaskAttention } from './task-attention';

function task(id = 'task', overrides: Partial<WorkspaceTaskOverview> = {}): WorkspaceTaskOverview {
  return {
    task: { id, projectId: 'project', title: 'Kiểm tra 👋', phase: 'RUNNING' },
    activeSession: undefined,
    latestSession: undefined,
    previousSession: undefined,
    artifacts: [],
    autoAdvanceCount: 0,
    blocked: false,
    dependencies: [],
    dependents: [],
    latestPlan: undefined,
    latestReview: undefined,
    qualityGateRuns: [],
    reviewHistory: [],
    workflowPlugin: undefined,
    canBeginPlanning: false,
    canAcceptPlan: false,
    canApproveReview: false,
    canRequestChanges: false,
    canRequestReview: false,
    canRetryExecution: false,
    canRevisePlan: false,
    canRunQualityGate: false,
    canStartExecution: false,
    canStartPlanning: false,
    ...overrides,
  };
}
function overview(...tasks: WorkspaceTaskOverview[]): AgentWorkspaceOverview {
  return { agents: [], projects: [{ project: { id: 'project', name: 'Project' }, tasks }] };
}
function gate(
  id: string,
  gateId: string,
  status: QualityGateRunSummary['status'],
  startedAt: number,
): QualityGateRunSummary {
  return {
    id,
    gateId,
    status,
    startedAt,
    taskId: 'task',
    kind: 'TEST',
    durationMs: undefined,
    exitCode: undefined,
    failureCategory: undefined,
    finishedAt: status === 'RUNNING' ? undefined : startedAt + 1,
    output: undefined,
  };
}
const failedSession = {
  id: 'session',
  taskId: 'task',
  agentId: 'test',
  createdAt: 1,
  endedAt: 10,
  failureCode: 'WRITE',
  status: 'FAILED',
} as const;

describe('task attention read model', () => {
  it('groups multiple reasons into one task without mutating the workspace', () => {
    const input = overview(
      task('task', {
        latestSession: failedSession,
        blocked: true,
        dependencies: [{ id: 'dep', title: 'Dependency', phase: 'RUNNING', satisfied: false }],
        qualityGateRuns: [gate('run', 'test', 'FAILED', 20)],
      }),
    );
    const before = JSON.stringify(input);
    const result = deriveTaskAttention(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ taskId: 'task', projectId: 'project', title: 'Kiểm tra 👋' });
    expect(result[0]!.reasons.map((r) => r.kind)).toEqual([
      'SESSION_FAILED',
      'GATE_FAILED',
      'DEPENDENCY_BLOCKED',
    ]);
    expect(result[0]!.reasons.map((r) => r.occurredAt)).toEqual([10, 21, undefined]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('uses the latest attempt of each gate, not old failures or a different passing gate', () => {
    const runs = [
      gate('a1', 'a', 'FAILED', 1),
      gate('b1', 'b', 'FAILED', 2),
      gate('a2', 'a', 'PASSED', 3),
      gate('c1', 'c', 'PASSED', 4),
    ];
    const result = deriveTaskAttention(overview(task('task', { qualityGateRuns: runs })));
    expect(result[0]!.reasons.map((r) => r.evidenceId)).toEqual(['b1']);
    expect(result[0]!.reasons[0]).toMatchObject({ gateId: 'b', gateStatus: 'FAILED' });
    expect(
      deriveTaskAttention(
        overview(task('task', { qualityGateRuns: [...runs, gate('b2', 'b', 'RUNNING', 5)] })),
      ),
    ).toEqual([]);
  });
  it.each(['FAILED', 'TIMED_OUT', 'LAUNCH_FAILED', 'INFRASTRUCTURE_FAILED'] as const)(
    'includes %s gate evidence',
    (status) => {
      expect(
        deriveTaskAttention(
          overview(task('task', { qualityGateRuns: [gate('r', 'g', status, 1)] })),
        )[0]!.reasons[0]!.kind,
      ).toBe('GATE_FAILED');
    },
  );
  it('does not keep a historical failed session after a retry or infer failure from exit', () => {
    for (const status of ['STARTING', 'WORKING', 'WAITING_INPUT', 'IDLE', 'EXITED'] as const) {
      expect(
        deriveTaskAttention(
          overview(
            task('task', {
              previousSession: failedSession,
              latestSession: { ...failedSession, id: 'new', status },
            }),
          ),
        ),
      ).toEqual([]);
    }
  });
  it('uses repository attempt order even if the wall clock moves backwards', () => {
    expect(
      deriveTaskAttention(
        overview(
          task('task', {
            qualityGateRuns: [
              gate('old', 'gate', 'FAILED', 100),
              gate('new', 'gate', 'PASSED', 50),
            ],
          }),
        ),
      ),
    ).toEqual([]);
  });
  it('keeps tasks from different projects distinct and ignores foreign evidence', () => {
    const input = overview(
      task('task', {
        latestSession: { ...failedSession, taskId: 'foreign' },
        qualityGateRuns: [{ ...gate('foreign', 'gate', 'FAILED', 1), taskId: 'foreign' }],
      }),
    );
    expect(deriveTaskAttention(input)).toEqual([]);
    const multiple = {
      ...input,
      projects: [
        { project: { id: 'project', name: 'First' }, tasks: [task('one', { blocked: true })] },
        {
          project: { id: 'second', name: 'Second' },
          tasks: [
            task('two', { blocked: true, task: { ...task('two').task, projectId: 'second' } }),
          ],
        },
      ],
    };
    expect(deriveTaskAttention(multiple).map((item) => [item.taskId, item.projectId])).toEqual([
      ['one', 'project'],
      ['two', 'second'],
    ]);
  });
  it('shows only an explicitly acceptable plan in planning', () => {
    const planning = task('task', {
      task: { ...task().task, phase: 'PLANNING' },
      canAcceptPlan: true,
      latestPlan: {
        canonicalName: 'planning/plan.md',
        content: '# Plan',
        createdAt: 30,
        id: 'plan',
        kind: 'plan',
        phase: 'PLANNING',
        format: 'markdown',
        schemaVersion: 1,
        sessionId: 'session',
        taskId: 'task',
        validation: 'VALID',
      },
    });
    expect(deriveTaskAttention(overview(planning))[0]!.reasons).toEqual([
      { kind: 'PLAN_PENDING', evidenceId: 'plan', occurredAt: 30 },
    ]);
    expect(deriveTaskAttention(overview({ ...planning, canAcceptPlan: false }))).toEqual([]);
    expect(deriveTaskAttention(overview({ ...planning, task: task().task }))).toEqual([]);
  });
  it('requires an actual pending review, not just the REVIEW phase', () => {
    const review = task('task', {
      task: { ...task().task, phase: 'REVIEW' },
      latestReview: {
        id: 'review',
        taskId: 'task',
        requestedAt: 40,
        status: 'PENDING',
        decidedAt: undefined,
        decisionNote: undefined,
        freshness: 'REVALIDATE_ON_APPROVAL',
        artifacts: [],
        qualityGates: [],
        codeState: {
          baseCommitId: 'base',
          branchName: 'branch',
          headCommitId: 'head',
          fingerprint: 'fp',
          schemaVersion: 1,
          changes: {
            committed: [],
            conflicted: [],
            staged: [],
            unstaged: [],
            untracked: [],
            total: 0,
            truncated: false,
          },
        },
      },
    });
    expect(deriveTaskAttention(overview(review))[0]!.reasons[0]).toEqual({
      kind: 'REVIEW_PENDING',
      evidenceId: 'review',
      occurredAt: 40,
    });
    expect(deriveTaskAttention(overview({ ...review, latestReview: undefined }))).toEqual([]);
    expect(
      deriveTaskAttention(
        overview({ ...review, latestReview: { ...review.latestReview!, status: 'APPROVED' } }),
      ),
    ).toEqual([]);
  });
  it('excludes done tasks and produces stable cross-project task counts', () => {
    const blocked = task('blocked', { blocked: true });
    const failed = task('failed', { latestSession: { ...failedSession, taskId: 'failed' } });
    const done = task('done', { blocked: true, task: { ...task('done').task, phase: 'DONE' } });
    const input = overview(blocked, done, failed);
    expect(deriveTaskAttention(input).map((t) => t.taskId)).toEqual(['failed', 'blocked']);
    expect(deriveTaskAttention(overview(failed, blocked, done))).toEqual(
      deriveTaskAttention(input),
    );
    expect(deriveTaskAttention({ agents: [], projects: [] })).toEqual([]);
  });
});
