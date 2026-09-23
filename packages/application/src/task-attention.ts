import type {
  AgentWorkspaceOverview,
  QualityGateRunSummary,
  WorkspaceTaskOverview,
} from './workspace-overview';

export type TaskAttentionKind =
  'SESSION_FAILED' | 'GATE_FAILED' | 'PLAN_PENDING' | 'REVIEW_PENDING' | 'DEPENDENCY_BLOCKED';
export interface TaskAttentionReason {
  readonly gateId?: string;
  readonly gateStatus?: QualityGateRunSummary['status'];
  readonly kind: TaskAttentionKind;
  readonly evidenceId: string;
  /** Undefined when the existing read model does not carry an event timestamp. */
  readonly occurredAt: number | undefined;
}
export interface TaskAttentionItem {
  readonly taskId: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly phase: WorkspaceTaskOverview['task']['phase'];
  readonly reasons: readonly TaskAttentionReason[];
}

const priority: Record<TaskAttentionKind, number> = {
  SESSION_FAILED: 0,
  GATE_FAILED: 1,
  PLAN_PENDING: 2,
  REVIEW_PENDING: 2,
  DEPENDENCY_BLOCKED: 3,
};

/** Read-only projection of the existing, bounded workspace snapshot, not an event inbox.
 * No provider-output heuristics, writes, or additional infrastructure reads.
 */
export function deriveTaskAttention(
  overview: AgentWorkspaceOverview,
): readonly TaskAttentionItem[] {
  const items: TaskAttentionItem[] = [];
  for (const { project, tasks } of overview.projects) {
    for (const entry of tasks) {
      if (entry.task.phase === 'DONE') continue;
      const reasons: TaskAttentionReason[] = [];
      const session = entry.latestSession;
      if (
        session?.status === 'FAILED' &&
        session.taskId === entry.task.id &&
        (entry.activeSession === undefined || entry.activeSession.id === session.id)
      ) {
        reasons.push({
          kind: 'SESSION_FAILED',
          evidenceId: session.id,
          occurredAt: session.endedAt,
        });
      }
      const latestGates = new Map<string, QualityGateRunSummary>();
      for (const run of entry.qualityGateRuns) {
        if (run.taskId !== entry.task.id) continue;
        // Repository history is oldest-first by durable ordinal, not wall-clock time.
        latestGates.set(run.gateId, run);
      }
      for (const run of latestGates.values()) {
        if (
          ['FAILED', 'TIMED_OUT', 'LAUNCH_FAILED', 'INFRASTRUCTURE_FAILED'].includes(run.status)
        ) {
          reasons.push({
            kind: 'GATE_FAILED',
            gateId: run.gateId,
            gateStatus: run.status,
            evidenceId: run.id,
            occurredAt: run.finishedAt,
          });
        }
      }
      if (
        entry.task.phase === 'PLANNING' &&
        entry.canAcceptPlan &&
        entry.latestPlan?.taskId === entry.task.id
      ) {
        reasons.push({
          kind: 'PLAN_PENDING',
          evidenceId: entry.latestPlan.id,
          occurredAt: entry.latestPlan.createdAt,
        });
      }
      if (
        entry.task.phase === 'REVIEW' &&
        entry.latestReview?.status === 'PENDING' &&
        entry.latestReview.taskId === entry.task.id
      ) {
        reasons.push({
          kind: 'REVIEW_PENDING',
          evidenceId: entry.latestReview.id,
          occurredAt: entry.latestReview.requestedAt,
        });
      }
      if (entry.blocked)
        reasons.push({
          kind: 'DEPENDENCY_BLOCKED',
          evidenceId: entry.task.id,
          occurredAt: undefined,
        });
      reasons.sort(
        (a, b) =>
          priority[a.kind] - priority[b.kind] ||
          (b.occurredAt ?? -1) - (a.occurredAt ?? -1) ||
          a.evidenceId.localeCompare(b.evidenceId),
      );
      if (reasons.length > 0)
        items.push(
          Object.freeze({
            taskId: entry.task.id,
            title: entry.task.title,
            projectId: project.id,
            projectName: project.name,
            phase: entry.task.phase,
            reasons: Object.freeze(reasons.map((reason) => Object.freeze(reason))),
          }),
        );
    }
  }
  return Object.freeze(
    items.sort(
      (a, b) =>
        priority[a.reasons[0]!.kind] - priority[b.reasons[0]!.kind] ||
        (b.reasons[0]!.occurredAt ?? -1) - (a.reasons[0]!.occurredAt ?? -1) ||
        a.taskId.localeCompare(b.taskId),
    ),
  );
}
