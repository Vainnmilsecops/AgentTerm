import { describe, expect, it } from 'vitest';

import {
  decideTaskReview,
  ExecutionArtifactKind,
  InvalidTaskReviewTransitionError,
  QualityGateKind,
  QualityGateRunStatus,
  startTaskReview,
  TaskPhase,
  TaskReviewGateAssociation,
  TaskReviewStatus,
  type StartTaskReviewInput,
  type TaskReview,
  type TaskReviewArtifactEvidence,
  type TaskReviewQualityGateEvidence,
} from './index';

const codeState = {
  branchName: 'agentterm/task/review-flow',
  baseCommitId: 'a'.repeat(40),
  changes: {
    committed: ['packages/domain/src/task.ts'],
    conflicted: [],
    staged: ['packages/domain/src/task-review.test.ts'],
    total: 4,
    truncated: false,
    unstaged: ['docs/CURRENT_STATE.md'],
    untracked: ['packages/domain/src/task-review.ts'],
  },
  fingerprint: 'f'.repeat(64),
  headCommitId: 'b'.repeat(40),
  schemaVersion: 1,
  worktreePathIdentity: 'win32:d:\\agentterm-worktrees\\review-flow',
} as const;

const artifacts = [
  {
    createdAt: 20,
    id: 'artifact-plan',
    kind: ExecutionArtifactKind.PLAN,
    phase: TaskPhase.PLANNING,
    sessionId: undefined,
  },
  {
    createdAt: 30,
    id: 'artifact-summary',
    kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
    phase: TaskPhase.RUNNING,
    sessionId: 'session-1',
  },
] as const;

const gates = [
  {
    association: TaskReviewGateAssociation.HEAD_MATCH_ONLY,
    baseCommitId: codeState.baseCommitId,
    branchName: codeState.branchName,
    finishedAt: 45,
    gateId: 'lint',
    headCommitIdAtStart: codeState.headCommitId,
    id: 'gate-run-lint',
    kind: QualityGateKind.LINT,
    observedStatus: QualityGateRunStatus.PASSED,
    startedAt: 40,
    worktreePathIdentity: codeState.worktreePathIdentity,
  },
  {
    association: TaskReviewGateAssociation.STALE,
    baseCommitId: codeState.baseCommitId,
    branchName: codeState.branchName,
    finishedAt: 37,
    gateId: 'test',
    headCommitIdAtStart: 'c'.repeat(40),
    id: 'gate-run-test',
    kind: QualityGateKind.TEST,
    observedStatus: QualityGateRunStatus.FAILED,
    startedAt: 35,
    worktreePathIdentity: codeState.worktreePathIdentity,
  },
] as const;

function validInput(): StartTaskReviewInput {
  return {
    artifacts,
    codeState,
    qualityGates: gates,
    id: 'review-1',
    requestedAt: 50,
    taskId: 'task-1',
  };
}

describe('startTaskReview', () => {
  it('creates an immutable pending snapshot with exact code and evidence associations', () => {
    const input = validInput();

    const review = startTaskReview(input);

    expect(review).toEqual({
      artifacts,
      codeState: {
        ...codeState,
        changes: {
          committed: ['packages/domain/src/task.ts'],
          conflicted: [],
          staged: ['packages/domain/src/task-review.test.ts'],
          total: 4,
          truncated: false,
          unstaged: ['docs/CURRENT_STATE.md'],
          untracked: ['packages/domain/src/task-review.ts'],
        },
      },
      decidedAt: undefined,
      decisionNote: undefined,
      qualityGates: gates,
      id: 'review-1',
      requestedAt: 50,
      status: TaskReviewStatus.PENDING,
      taskId: 'task-1',
    });
    expect(Object.isFrozen(review)).toBe(true);
    expect(Object.isFrozen(review.codeState)).toBe(true);
    expect(Object.isFrozen(review.codeState.changes)).toBe(true);
    expect(Object.isFrozen(review.codeState.changes.committed)).toBe(true);
    expect(Object.isFrozen(review.artifacts)).toBe(true);
    expect(Object.isFrozen(review.artifacts[0])).toBe(true);
    expect(Object.isFrozen(review.qualityGates)).toBe(true);
    expect(Object.isFrozen(review.qualityGates[0])).toBe(true);
  });

  it('copies caller-owned arrays so later mutations cannot rewrite review history', () => {
    const committed = ['src/original.ts'];
    const artifactValues: TaskReviewArtifactEvidence[] = [{ ...artifacts[0] }];
    const gateValues: TaskReviewQualityGateEvidence[] = [{ ...gates[0] }];
    const review = startTaskReview({
      ...validInput(),
      artifacts: artifactValues,
      codeState: {
        ...codeState,
        changes: {
          committed,
          conflicted: [],
          staged: [],
          total: 1,
          truncated: false,
          unstaged: [],
          untracked: [],
        },
      },
      qualityGates: gateValues,
    });

    committed.push('src/later.ts');
    artifactValues[0] = { ...artifactValues[0]!, id: 'artifact-replaced' };
    gateValues[0] = { ...gateValues[0]!, id: 'gate-replaced' };

    expect(review.codeState.changes.committed).toEqual(['src/original.ts']);
    expect(review.artifacts.map(({ id }) => id)).toEqual(['artifact-plan']);
    expect(review.qualityGates.map(({ id }) => id)).toEqual(['gate-run-lint']);
  });

  it('retains only the structured review-safe fields from associated evidence', () => {
    const artifactWithContent = {
      ...artifacts[0],
      content: 'Agent output must not leak through an evidence reference.',
    } as TaskReviewArtifactEvidence;
    const gateWithLocalPath = {
      ...gates[0],
      worktreePath: 'D:\\private\\worktree',
    } as TaskReviewQualityGateEvidence;

    const review = startTaskReview({
      ...validInput(),
      artifacts: [artifactWithContent],
      qualityGates: [gateWithLocalPath],
    });

    expect(review.artifacts[0]).not.toHaveProperty('content');
    expect(review.qualityGates[0]).not.toHaveProperty('worktreePath');
  });

  it('rejects Review snapshots that exceed the durable Artifact association limit', () => {
    const artifactEvidence = Array.from({ length: 1_001 }, (_, index) => ({
      createdAt: 20,
      id: `artifact-${index}`,
      kind: ExecutionArtifactKind.PLAN,
      phase: TaskPhase.PLANNING,
      sessionId: undefined,
    }));

    expect(() =>
      startTaskReview({
        ...validInput(),
        artifacts: artifactEvidence,
      }),
    ).toThrow(TypeError);
    expect(() =>
      startTaskReview({
        ...validInput(),
        artifacts: artifactEvidence.slice(0, 1_000),
      }),
    ).not.toThrow();
  });

  it('rejects Review snapshots that exceed the durable Quality Gate association limit', () => {
    const qualityGateEvidence = Array.from({ length: 1_001 }, (_, index) => ({
      ...gates[0],
      gateId: `gate-${index}`,
      id: `gate-run-${index}`,
    }));

    expect(() =>
      startTaskReview({
        ...validInput(),
        qualityGates: qualityGateEvidence,
      }),
    ).toThrow(TypeError);
    expect(() =>
      startTaskReview({
        ...validInput(),
        qualityGates: qualityGateEvidence.slice(0, 1_000),
      }),
    ).not.toThrow();
  });

  it.each([
    ['blank review id', { id: '   ' }],
    ['invalid request timestamp', { requestedAt: -1 }],
    ['invalid SHA-256 fingerprint', { codeState: { ...codeState, fingerprint: 'ABC' } }],
    ['invalid Git object id', { codeState: { ...codeState, headCommitId: 'not-an-object-id' } }],
    [
      'inconsistent complete change count',
      { codeState: { ...codeState, changes: { ...codeState.changes, total: 3 } } },
    ],
    [
      'invalid changed path',
      {
        codeState: {
          ...codeState,
          changes: { ...codeState.changes, committed: ['src/good.ts', 'bad\0path'] },
        },
      },
    ],
    [
      'artifact kind and phase mismatch',
      { artifacts: [{ ...artifacts[0], phase: TaskPhase.RUNNING }] },
    ],
    [
      'artifact created after the review request',
      { artifacts: [{ ...artifacts[0], createdAt: 51 }] },
    ],
    [
      'terminal gate without finish timestamp',
      { qualityGates: [{ ...gates[0], finishedAt: undefined }] },
    ],
    [
      'running gate with finish timestamp',
      {
        qualityGates: [
          { ...gates[0], finishedAt: 45, observedStatus: QualityGateRunStatus.RUNNING },
        ],
      },
    ],
    [
      'gate association inconsistent with captured code state',
      { qualityGates: [{ ...gates[0], association: TaskReviewGateAssociation.STALE }] },
    ],
    [
      'gate evidence completed after the review request',
      { qualityGates: [{ ...gates[0], finishedAt: 51 }] },
    ],
  ])('rejects %s', (_caseName, override) => {
    const input = { ...validInput(), ...override } as StartTaskReviewInput;

    expect(() => startTaskReview(input)).toThrow(TypeError);
  });
});

describe('decideTaskReview', () => {
  it('approves a pending review without mutating its captured snapshot', () => {
    const pending = startTaskReview(validInput());

    const approved = decideTaskReview(pending, {
      decidedAt: 60,
      decisionNote: 'Evidence reviewed by the user.',
      status: TaskReviewStatus.APPROVED,
    });

    expect(approved).toEqual({
      ...pending,
      decidedAt: 60,
      decisionNote: 'Evidence reviewed by the user.',
      status: TaskReviewStatus.APPROVED,
    });
    expect(pending).toMatchObject({
      decidedAt: undefined,
      decisionNote: undefined,
      status: TaskReviewStatus.PENDING,
    });
    expect(approved).not.toBe(pending);
    expect(approved.codeState).toBe(pending.codeState);
    expect(approved.artifacts).toBe(pending.artifacts);
    expect(approved.qualityGates).toBe(pending.qualityGates);
    expect(Object.isFrozen(approved)).toBe(true);
  });

  it('records requested changes as a separate terminal decision', () => {
    const pending = startTaskReview(validInput());

    const changesRequested = decideTaskReview(pending, {
      decidedAt: 61,
      status: TaskReviewStatus.CHANGES_REQUESTED,
    });

    expect(changesRequested).toMatchObject({
      decidedAt: 61,
      decisionNote: undefined,
      status: TaskReviewStatus.CHANGES_REQUESTED,
    });
    expect(pending.status).toBe(TaskReviewStatus.PENDING);
  });

  it.each([TaskReviewStatus.APPROVED, TaskReviewStatus.CHANGES_REQUESTED])(
    'rejects a second decision after %s',
    (terminalStatus) => {
      const terminal = decideTaskReview(startTaskReview(validInput()), {
        decidedAt: 60,
        status: terminalStatus,
      });

      let caught: unknown;
      try {
        decideTaskReview(terminal, {
          decidedAt: 70,
          status: TaskReviewStatus.APPROVED,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(InvalidTaskReviewTransitionError);
      expect(caught).toMatchObject({ from: terminalStatus, to: TaskReviewStatus.APPROVED });
      expect(terminal.status).toBe(terminalStatus);
    },
  );

  it.each([
    ['pending as a decision', { decidedAt: 60, status: TaskReviewStatus.PENDING }],
    ['decision before request', { decidedAt: 49, status: TaskReviewStatus.APPROVED }],
    [
      'blank decision note',
      { decidedAt: 60, decisionNote: '   ', status: TaskReviewStatus.APPROVED },
    ],
    [
      'NUL in decision note',
      { decidedAt: 60, decisionNote: 'hidden\0text', status: TaskReviewStatus.APPROVED },
    ],
  ])('rejects %s', (_caseName, decision) => {
    const pending = startTaskReview(validInput());

    expect(() =>
      decideTaskReview(pending, decision as Parameters<typeof decideTaskReview>[1]),
    ).toThrow();
    expect(pending.status).toBe(TaskReviewStatus.PENDING);
  });

  it('rejects a forged mutable review snapshot before finalization', () => {
    const pending = startTaskReview(validInput());
    const forged = {
      ...pending,
      codeState: { ...pending.codeState, fingerprint: 'invalid' },
    } as TaskReview;

    expect(() =>
      decideTaskReview(forged, { decidedAt: 60, status: TaskReviewStatus.APPROVED }),
    ).toThrow(TypeError);
  });

  it('rejects oversized durable decision notes and visible changed-path evidence', () => {
    const pending = startTaskReview(validInput());

    expect(() =>
      decideTaskReview(pending, {
        decidedAt: 60,
        decisionNote: 'x'.repeat(65_537),
        status: TaskReviewStatus.APPROVED,
      }),
    ).toThrow(TypeError);
    expect(() =>
      startTaskReview({
        ...validInput(),
        codeState: {
          ...codeState,
          changes: {
            committed: Array.from({ length: 201 }, (_, index) => `src/file-${index}.ts`),
            conflicted: [],
            staged: [],
            total: 201,
            truncated: false,
            unstaged: [],
            untracked: [],
          },
        },
      }),
    ).toThrow(TypeError);
    expect(() =>
      startTaskReview({
        ...validInput(),
        codeState: {
          ...codeState,
          changes: {
            committed: [`src/${'x'.repeat(32_769)}`],
            conflicted: [],
            staged: [],
            total: 1,
            truncated: false,
            unstaged: [],
            untracked: [],
          },
        },
      }),
    ).toThrow(TypeError);
  });
});
