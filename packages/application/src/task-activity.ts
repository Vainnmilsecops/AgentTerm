import type {
  AgentSession,
  ExecutionArtifact,
  QualityGateRun,
  TaskReview,
  TaskTransitionAudit,
} from '@agentterm/domain';

import { EntityNotFoundError } from './errors';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  PullRequestRepository,
  QualityGateRunRepository,
  TaskRepository,
  TaskReviewRepository,
  TaskTransitionLog,
  TaskPullRequest,
} from './ports';

export interface TaskActivityDependencies {
  readonly tasks: Pick<TaskRepository, 'findById'>;
  readonly sessions: Pick<AgentSessionRepository, 'listByTaskId'>;
  readonly artifacts: Pick<ExecutionArtifactRepository, 'listByTaskId'>;
  readonly qualityGateRuns: Pick<QualityGateRunRepository, 'listByTaskId'>;
  readonly reviews: Pick<TaskReviewRepository, 'listByTaskId'>;
  readonly taskTransitions: Pick<TaskTransitionLog, 'listByTaskId'>;
  readonly pullRequests: Pick<PullRequestRepository, 'listByTaskId'>;
}

interface ActivityBase {
  readonly id: string;
  readonly occurredAt: number;
}

interface SessionActivity extends ActivityBase {
  readonly agentId: string;
  readonly attempt: number;
  readonly continuedFromSessionId: string | undefined;
  readonly kind: 'SESSION_STARTED' | 'SESSION_STOP_REQUESTED' | 'SESSION_EXITED' | 'SESSION_FAILED';
  readonly sessionId: string;
}

interface ArtifactActivity extends ActivityBase {
  readonly artifactId: string;
  readonly artifactKind: ExecutionArtifact['kind'];
  readonly kind: 'ARTIFACT';
  readonly phase: ExecutionArtifact['phase'];
  readonly sessionId: string | undefined;
}

interface QualityGateActivity extends ActivityBase {
  readonly finishedAt: number | undefined;
  readonly gateKind: QualityGateRun['gate']['kind'];
  readonly kind: 'QUALITY_GATE';
  readonly runId: string;
  readonly startedAt: number;
  readonly status: QualityGateRun['status'];
}

interface ReviewActivity extends ActivityBase {
  readonly kind: 'REVIEW_REQUESTED' | 'REVIEW_DECIDED';
  readonly reviewId: string;
  readonly status: TaskReview['status'];
}

interface PhaseActivity extends ActivityBase {
  readonly fromPhase: TaskTransitionAudit['fromPhase'];
  readonly kind: 'PHASE_TRANSITION';
  readonly toPhase: TaskTransitionAudit['toPhase'];
  readonly transitionId: string;
  readonly trigger: TaskTransitionAudit['trigger'];
}

interface PullRequestActivity extends ActivityBase {
  readonly checks: TaskPullRequest['checks']['state'];
  readonly draft: boolean;
  readonly kind: 'PULL_REQUEST_SNAPSHOT';
  readonly number: number;
  readonly observedAt: number;
  readonly reviewState: TaskPullRequest['reviewState'];
  readonly status: TaskPullRequest['status'];
  readonly url: string;
}

export type TaskActivityItem =
  | SessionActivity
  | ArtifactActivity
  | QualityGateActivity
  | ReviewActivity
  | PhaseActivity
  | PullRequestActivity;

export interface TaskActivityTimeline {
  readonly items: readonly TaskActivityItem[];
  readonly taskId: string;
}

/** Reads existing Task evidence only; this projection never records an activity of its own. */
export async function loadTaskActivity(
  taskId: string,
  dependencies: TaskActivityDependencies,
): Promise<TaskActivityTimeline> {
  const task = await dependencies.tasks.findById(taskId);
  if (task === undefined) throw new EntityNotFoundError('Task', taskId);

  const [sessions, artifacts, qualityGateRuns, reviews, taskTransitions, pullRequests] =
    await Promise.all([
      dependencies.sessions.listByTaskId(taskId),
      dependencies.artifacts.listByTaskId(taskId),
      dependencies.qualityGateRuns.listByTaskId(taskId),
      dependencies.reviews.listByTaskId(taskId),
      dependencies.taskTransitions.listByTaskId(taskId),
      dependencies.pullRequests.listByTaskId(taskId),
    ]);

  for (const history of [
    sessions,
    artifacts,
    qualityGateRuns,
    reviews,
    taskTransitions,
    pullRequests,
  ]) {
    if (history.some((record) => record.taskId !== taskId)) {
      throw new Error('Task activity history is inconsistent.');
    }
  }

  const items: TaskActivityItem[] = [];
  const orderedSessions = [...sessions].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const providerConversations = new Map<string, Map<string, string>>();
  for (const [index, session] of orderedSessions.entries()) {
    const byProvider = providerConversations.get(session.agentId) ?? new Map<string, string>();
    const continuedFromSessionId =
      session.providerSessionId === undefined
        ? undefined
        : byProvider.get(session.providerSessionId);
    appendSessionActivity(items, session, index + 1, continuedFromSessionId);
    if (session.providerSessionId !== undefined) {
      byProvider.set(session.providerSessionId, session.id);
      providerConversations.set(session.agentId, byProvider);
    }
  }
  for (const artifact of artifacts) {
    items.push(
      Object.freeze({
        artifactId: artifact.id,
        artifactKind: artifact.kind,
        id: `artifact:${artifact.id}`,
        kind: 'ARTIFACT',
        occurredAt: artifact.createdAt,
        phase: artifact.phase,
        sessionId: artifact.sessionId,
      }),
    );
  }
  for (const run of qualityGateRuns) {
    items.push(
      Object.freeze({
        finishedAt: run.finishedAt,
        gateKind: run.gate.kind,
        id: `quality-gate:${run.id}`,
        kind: 'QUALITY_GATE',
        occurredAt: run.finishedAt ?? run.startedAt,
        runId: run.id,
        startedAt: run.startedAt,
        status: run.status,
      }),
    );
  }
  for (const review of reviews) {
    items.push(
      Object.freeze({
        id: `review:${review.id}:requested`,
        kind: 'REVIEW_REQUESTED',
        occurredAt: review.requestedAt,
        reviewId: review.id,
        status: 'PENDING',
      }),
    );
    if (review.decidedAt !== undefined) {
      items.push(
        Object.freeze({
          id: `review:${review.id}:decided`,
          kind: 'REVIEW_DECIDED',
          occurredAt: review.decidedAt,
          reviewId: review.id,
          status: review.status,
        }),
      );
    }
  }
  for (const transition of taskTransitions) {
    items.push(
      Object.freeze({
        fromPhase: transition.fromPhase,
        id: `phase:${transition.id}`,
        kind: 'PHASE_TRANSITION',
        occurredAt: transition.createdAt,
        toPhase: transition.toPhase,
        transitionId: transition.id,
        trigger: transition.trigger,
      }),
    );
  }
  for (const pullRequest of pullRequests) {
    const observedAt = pullRequest.lastSyncedAt ?? pullRequest.createdAt;
    items.push(
      Object.freeze({
        checks: pullRequest.checks.state,
        draft: pullRequest.draft,
        id: `pull-request:${pullRequest.repositoryOwner}/${pullRequest.repositoryName}#${pullRequest.number}`,
        kind: 'PULL_REQUEST_SNAPSHOT',
        number: pullRequest.number,
        observedAt,
        occurredAt: observedAt,
        reviewState: pullRequest.reviewState,
        status: pullRequest.status,
        url: pullRequest.url,
      }),
    );
  }

  items.sort(
    (left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id),
  );
  return Object.freeze({ items: Object.freeze(items), taskId });
}

function appendSessionActivity(
  items: TaskActivityItem[],
  session: AgentSession,
  attempt: number,
  continuedFromSessionId: string | undefined,
): void {
  for (const event of session.history) {
    const kind =
      event.kind === 'START_REQUESTED'
        ? 'SESSION_STARTED'
        : event.kind === 'STOP_REQUESTED'
          ? 'SESSION_STOP_REQUESTED'
          : event.kind === 'PROCESS_EXITED'
            ? 'SESSION_EXITED'
            : event.kind === 'RUNTIME_FAILED' && event.fatal
              ? 'SESSION_FAILED'
              : undefined;
    if (kind === undefined) continue;
    items.push(
      Object.freeze({
        agentId: session.agentId,
        attempt,
        continuedFromSessionId,
        id: `session:${session.id}:${event.sequence}`,
        kind,
        occurredAt: event.occurredAt,
        sessionId: session.id,
      }),
    );
  }
}
