import {
  QualityGateRunStatus,
  reconcileOrphanQualityGateRun,
} from '@agentterm/domain';

import { QualityGatePersistenceError } from './errors';
import type { QualityGateRunRepository } from './ports';

export interface ReconcileOrphanQualityGateRunsDependencies {
  /** Returns the current wall-clock time as a nonnegative integer. */
  readonly clock: () => number;
  /** Repository of Quality Gate evidence rows. */
  readonly runs: QualityGateRunRepository;
}

export interface ReconcileOrphanQualityGateRunsResult {
  /** Ids of rows that this call finalized. A row that lost a concurrent finalize race is not listed. */
  readonly reconciledRunIds: readonly string[];
}

/**
 * Reconciles every Quality Gate run that is still `status = RUNNING` after
 * the previous AgentTerm process exited. The previous runner may have died
 * before persisting the final checkpoint, or the Windows process tree may
 * not have been settled. Either way the row is finalized here as
 * `INFRASTRUCTURE_FAILED` so Review admission and `canRunQualityGate` can
 * recover without human intervention.
 *
 * The reconcile is compare-and-set: if a concurrent window has already
 * finalized the row (its `finalize(run, 'RUNNING')` call won the race),
 * our `finalize` call throws `QualityGatePersistenceError` and we skip
 * the row. The use case returns the ids of rows this process actually
 * finalized; ids that lost the race are intentionally not listed.
 *
 * Runs once during process startup, before this process can own any gate
 * runner. Mirrors the agent-session restore discipline.
 */
export async function reconcileOrphanQualityGateRuns(
  dependencies: ReconcileOrphanQualityGateRunsDependencies,
): Promise<ReconcileOrphanQualityGateRunsResult> {
  const unsettledRuns = await dependencies.runs.listUnsettled();
  const reconciledRunIds: string[] = [];

  for (const current of unsettledRuns) {
    if (current.status !== QualityGateRunStatus.RUNNING) {
      // Defensive: listUnsettled promises RUNNING only, but a concurrent
      // finalize could have moved the row between the read and our loop.
      continue;
    }
    const lastEventAt = current.finishedAt ?? current.startedAt;
    const finishedAt = Math.max(dependencies.clock(), lastEventAt);
    const reconciled = reconcileOrphanQualityGateRun(current, finishedAt);
    try {
      await dependencies.runs.finalize(reconciled, 'RUNNING');
      reconciledRunIds.push(reconciled.id);
    } catch (error) {
      if (!(error instanceof QualityGatePersistenceError)) {
        throw error;
      }
      // Another window finalized this row first. The compare-and-set
      // contract rejects our write; the row is already settled, so we
      // skip it. The reconciliation continues with the next row.
      continue;
    }
  }

  return Object.freeze({ reconciledRunIds: Object.freeze(reconciledRunIds) });
}
