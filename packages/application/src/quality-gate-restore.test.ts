import {
  createQualityGate,
  QualityGateKind,
  QualityGateRunStatus,
  startQualityGateRun,
  UNOBSERVED_GATE_OUTPUT_REFERENCE,
  type QualityGateRun,
} from '@agentterm/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import { QualityGatePersistenceError } from './errors';
import type { QualityGateRunRepository } from './ports';
import { reconcileOrphanQualityGateRuns } from './quality-gate-restore';

const gate = createQualityGate({
  command: {
    arguments: ['--filter', '@agentterm/application', 'test'],
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
  },
  id: 'test-gate',
  kind: QualityGateKind.TEST,
  timeoutMs: 120_000,
});

const worktree = {
  baseCommitId: 'a'.repeat(40),
  branchName: 'agentterm/task/restore',
  headCommitIdAtStart: 'b'.repeat(40),
  pathIdentity: 'worktree-restore',
  worktreePath: 'D:\\AgentTerm Worktrees\\task-restore',
};

function startRun(overrides: { id: string; startedAt: number }): QualityGateRun {
  return startQualityGateRun({
    gate,
    id: overrides.id,
    startedAt: overrides.startedAt,
    taskId: 'task-restore',
    worktree,
  });
}

class InMemoryQualityGateRunRepository implements QualityGateRunRepository {
  private readonly runsById = new Map<string, QualityGateRun>();

  public async findById(id: string): Promise<QualityGateRun | undefined> {
    return this.runsById.get(id);
  }

  public async insert(run: QualityGateRun): Promise<void> {
    if (this.runsById.has(run.id)) {
      throw new Error(`duplicate run id ${run.id}`);
    }
    this.runsById.set(run.id, run);
  }

  public async finalize(run: QualityGateRun, expectedStatus: 'RUNNING'): Promise<void> {
    const stored = this.runsById.get(run.id);
    if (stored === undefined || stored.status !== expectedStatus) {
      throw new QualityGatePersistenceError(run);
    }
    this.runsById.set(run.id, run);
  }

  public async listByTaskId(taskId: string): Promise<readonly QualityGateRun[]> {
    return [...this.runsById.values()].filter((run) => run.taskId === taskId);
  }

  public async listRecentByTaskId(
    taskId: string,
    limit: number,
  ): Promise<readonly QualityGateRun[]> {
    const filtered = [...this.runsById.values()].filter((run) => run.taskId === taskId);
    return filtered.slice(-limit);
  }

  public async listUnsettled(): Promise<readonly QualityGateRun[]> {
    return [...this.runsById.values()]
      .filter((run) => run.status === QualityGateRunStatus.RUNNING)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  public async readReviewEvidenceByTaskId(): ReturnType<
    QualityGateRunRepository['readReviewEvidenceByTaskId']
  > {
    throw new Error('not used in these tests');
  }

  public seed(run: QualityGateRun): void {
    this.runsById.set(run.id, run);
  }
}

describe('reconcileOrphanQualityGateRuns', () => {
  let clockMs: number;
  let repository: InMemoryQualityGateRunRepository;
  let finalizeCalls: ReadonlyArray<{
    expectedStatus: 'RUNNING';
    run: QualityGateRun;
  }>;

  beforeEach(() => {
    clockMs = 10_000;
    repository = new InMemoryQualityGateRunRepository();
    finalizeCalls = [];
    const originalFinalize = repository.finalize.bind(repository);
    repository.finalize = async (run, expectedStatus) => {
      finalizeCalls = [...finalizeCalls, { expectedStatus, run }];
      await originalFinalize(run, expectedStatus);
    };
  });

  it('finalizes two RUNNING orphans in startedAt order with compare-and-set', async () => {
    const older = startRun({ id: 'orphan-older', startedAt: 1_000 });
    const newer = startRun({ id: 'orphan-newer', startedAt: 2_000 });
    const settled = startRun({ id: 'orphan-passed', startedAt: 3_000 });
    repository.seed(older);
    repository.seed(newer);
    repository.seed(settled);

    // Pre-existing PASSED row to make sure it is not touched. We mutate the
    // stored row directly because there is no public domain helper for
    // completing with arbitrary output in the test harness.
    const passedRow: QualityGateRun = {
      ...settled,
      durationMs: 50,
      exitCode: 0,
      failureCategory: undefined,
      finishedAt: 3_050,
      output: {
        reference: 'quality-gate-output:orphan-passed',
        text: 'OK',
        truncated: false,
      },
      status: QualityGateRunStatus.PASSED,
    };
    repository.seed(passedRow);

    const result = await reconcileOrphanQualityGateRuns({
      clock: () => clockMs,
      runs: repository,
    });

    expect(result.reconciledRunIds).toEqual(['orphan-older', 'orphan-newer']);
    expect(finalizeCalls.map((call) => call.run.id)).toEqual(['orphan-older', 'orphan-newer']);
    expect(finalizeCalls.map((call) => call.expectedStatus)).toEqual(['RUNNING', 'RUNNING']);

    const reconciledOlder = await repository.findById('orphan-older');
    const reconciledNewer = await repository.findById('orphan-newer');
    expect(reconciledOlder?.status).toBe(QualityGateRunStatus.INFRASTRUCTURE_FAILED);
    expect(reconciledOlder?.failureCategory).toBe('INFRASTRUCTURE');
    expect(reconciledOlder?.finishedAt).toBe(clockMs);
    expect(reconciledOlder?.output?.reference).toBe(
      `${UNOBSERVED_GATE_OUTPUT_REFERENCE}:orphan-older`,
    );
    expect(reconciledOlder?.output?.text).toBe('');
    expect(reconciledOlder?.output?.truncated).toBe(false);
    expect(reconciledNewer?.status).toBe(QualityGateRunStatus.INFRASTRUCTURE_FAILED);
    expect(reconciledNewer?.failureCategory).toBe('INFRASTRUCTURE');

    const unchangedPassed = await repository.findById('orphan-passed');
    expect(unchangedPassed?.status).toBe(QualityGateRunStatus.PASSED);
    expect(unchangedPassed?.output?.text).toBe('OK');
  });

  it('skips a row that lost the compare-and-set race and continues with the next orphan', async () => {
    const racer = startRun({ id: 'orphan-racer', startedAt: 5_000 });
    const survivor = startRun({ id: 'orphan-survivor', startedAt: 6_000 });
    repository.seed(racer);
    repository.seed(survivor);

    // Simulate a concurrent window finalizing 'orphan-racer' to PASSED before
    // our finalize call lands. The compare-and-set must reject the orphan
    // reconcile; the use case should swallow the rejection and continue.
    const racingPass = {
      ...racer,
      durationMs: 25,
      exitCode: 0,
      failureCategory: undefined,
      finishedAt: 5_025,
      output: {
        reference: 'quality-gate-output:orphan-racer',
        text: 'raced',
        truncated: false,
      },
      status: QualityGateRunStatus.PASSED,
    };
    repository.seed(racingPass);

    const result = await reconcileOrphanQualityGateRuns({
      clock: () => clockMs,
      runs: repository,
    });

    expect(result.reconciledRunIds).toEqual(['orphan-survivor']);

    const racerAfter = await repository.findById('orphan-racer');
    expect(racerAfter?.status).toBe(QualityGateRunStatus.PASSED);
    expect(racerAfter?.output?.text).toBe('raced');

    const survivorAfter = await repository.findById('orphan-survivor');
    expect(survivorAfter?.status).toBe(QualityGateRunStatus.INFRASTRUCTURE_FAILED);
  });

  it('returns an empty reconcile list and never calls finalize when no orphans exist', async () => {
    const passed = startRun({ id: 'orphan-none-passed', startedAt: 1_000 });
    const failed = startRun({ id: 'orphan-none-failed', startedAt: 1_500 });
    repository.seed({ ...passed, status: QualityGateRunStatus.PASSED });
    repository.seed({
      ...failed,
      durationMs: 60,
      exitCode: 2,
      failureCategory: 'COMMAND',
      finishedAt: 1_560,
      output: {
        reference: 'quality-gate-output:orphan-none-failed',
        text: 'failed',
        truncated: false,
      },
      status: QualityGateRunStatus.FAILED,
    });

    const result = await reconcileOrphanQualityGateRuns({
      clock: () => clockMs,
      runs: repository,
    });

    expect(result.reconciledRunIds).toEqual([]);
    expect(finalizeCalls).toEqual([]);
  });

  it('uses the clock for finishedAt so the audit trail reflects the reconcile wall time', async () => {
    const orphan = startRun({ id: 'orphan-clock', startedAt: 4_000 });
    repository.seed(orphan);
    clockMs = 12_345;

    await reconcileOrphanQualityGateRuns({
      clock: () => clockMs,
      runs: repository,
    });

    const after = await repository.findById('orphan-clock');
    expect(after?.finishedAt).toBe(12_345);
    expect(after?.durationMs).toBe(12_345 - 4_000);
  });
});
