import { useEffect, useState } from 'react';

import type { TaskActivityItem, TaskActivityTimeline } from '@agentterm/application';

import type { AgentWorkspaceClient } from './workspace-controller';

export type TaskActivityFilter =
  'ALL' | 'SESSION' | 'ARTIFACT' | 'QUALITY_GATE' | 'REVIEW' | 'PHASE' | 'PULL_REQUEST';
export type TaskActivityTarget = 'artifacts' | 'checks' | 'review';

const filters: readonly { readonly id: TaskActivityFilter; readonly label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'SESSION', label: 'Sessions' },
  { id: 'ARTIFACT', label: 'Artifacts' },
  { id: 'QUALITY_GATE', label: 'Checks' },
  { id: 'REVIEW', label: 'Reviews' },
  { id: 'PHASE', label: 'Phases' },
  { id: 'PULL_REQUEST', label: 'PRs' },
];

const initialVisibleCount = 20;

export function filterTaskActivity(
  items: readonly TaskActivityItem[],
  filter: TaskActivityFilter,
): readonly TaskActivityItem[] {
  if (filter === 'ALL') return items;
  return items.filter((item) =>
    filter === 'SESSION'
      ? item.kind.startsWith('SESSION_')
      : filter === 'REVIEW'
        ? item.kind.startsWith('REVIEW_')
        : filter === 'PULL_REQUEST'
          ? item.kind === 'PULL_REQUEST_SNAPSHOT'
          : filter === 'PHASE'
            ? item.kind === 'PHASE_TRANSITION'
            : item.kind === filter,
  );
}

export interface TaskActivityTimelineProps {
  readonly client: AgentWorkspaceClient;
  readonly onOpenPullRequest: ((url: string) => void) | undefined;
  readonly onReveal: (target: TaskActivityTarget) => void;
  /** A fresh workspace overview means evidence may have changed. */
  readonly refreshKey: object;
  readonly taskId: string;
}

type ActivityLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly timeline: TaskActivityTimeline };

export function TaskActivityTimeline({
  client,
  onOpenPullRequest,
  onReveal,
  refreshKey,
  taskId,
}: TaskActivityTimelineProps) {
  const [state, setState] = useState<ActivityLoadState>({ kind: 'loading' });
  const [filter, setFilter] = useState<TaskActivityFilter>('ALL');
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ kind: 'loading' });
    void client.loadTaskActivity({ taskId }).then(
      (timeline) => {
        if (current) setState({ kind: 'ready', timeline });
      },
      () => {
        if (current) setState({ kind: 'error' });
      },
    );
    return () => {
      current = false;
    };
  }, [client, refreshKey, reload, taskId]);

  if (state.kind === 'loading') {
    return (
      <p className="task-activity__message" role="status">
        Loading Task activity…
      </p>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="task-activity__message" role="alert">
        <span>Task activity could not be loaded.</span>
        <button
          className="secondary-action"
          onClick={() => setReload((value) => value + 1)}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <TaskActivityTimelineView
      filter={filter}
      onFilterChange={(next) => {
        setFilter(next);
        setVisibleCount(initialVisibleCount);
      }}
      onOpenPullRequest={onOpenPullRequest}
      onReveal={onReveal}
      onShowMore={() => setVisibleCount((count) => count + initialVisibleCount)}
      timeline={state.timeline}
      visibleCount={visibleCount}
    />
  );
}

export interface TaskActivityTimelineViewProps {
  readonly filter: TaskActivityFilter;
  readonly onFilterChange: (filter: TaskActivityFilter) => void;
  readonly onOpenPullRequest: ((url: string) => void) | undefined;
  readonly onReveal: (target: TaskActivityTarget) => void;
  readonly onShowMore: () => void;
  readonly timeline: TaskActivityTimeline;
  readonly visibleCount: number;
}

export function TaskActivityTimelineView({
  filter,
  onFilterChange,
  onOpenPullRequest,
  onReveal,
  onShowMore,
  timeline,
  visibleCount,
}: TaskActivityTimelineViewProps) {
  const filtered = filterTaskActivity(timeline.items, filter);
  const visible = filtered.slice(0, visibleCount);
  return (
    <section aria-label="Task activity" className="task-activity">
      <div className="task-activity__heading">
        <div>
          <p className="eyebrow">History</p>
          <h3>Task activity</h3>
        </div>
        <span className="task-activity__count">{timeline.items.length} events</span>
      </div>
      <p className="task-activity__hint">
        Read-only history from saved sessions and evidence. PR entries show the latest stored
        snapshot.
      </p>
      <div aria-label="Filter Task activity" className="task-activity__filters" role="group">
        {filters.map(({ id, label }) => (
          <button
            aria-pressed={filter === id}
            className="task-activity__filter"
            key={id}
            onClick={() => onFilterChange(id)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="task-activity__message">
          {filter === 'ALL'
            ? 'No saved activity for this Task yet.'
            : `No ${filter === 'REVIEW' ? 'review' : filter === 'SESSION' ? 'session' : filter === 'PULL_REQUEST' ? 'PR' : filter === 'QUALITY_GATE' ? 'check' : filter === 'PHASE' ? 'phase' : 'artifact'} activity for this Task.`}
        </p>
      ) : (
        <>
          <ol className="task-activity__list">
            {visible.map((item) => (
              <li className="task-activity__item" key={item.id}>
                <div className="task-activity__item-top">
                  <span className="task-activity__type">{activityType(item)}</span>
                  <time dateTime={new Date(item.occurredAt).toISOString()}>
                    {new Date(item.occurredAt).toLocaleString()}
                  </time>
                </div>
                <strong>{activityTitle(item)}</strong>
                <p>{activityDetail(item)}</p>
                {item.kind === 'ARTIFACT' ? (
                  <button
                    className="task-activity__link"
                    onClick={() => onReveal('artifacts')}
                    type="button"
                  >
                    View artifact history
                  </button>
                ) : item.kind === 'QUALITY_GATE' ? (
                  <button
                    className="task-activity__link"
                    onClick={() => onReveal('checks')}
                    type="button"
                  >
                    View validation results
                  </button>
                ) : item.kind.startsWith('REVIEW_') ? (
                  <button
                    className="task-activity__link"
                    onClick={() => onReveal('review')}
                    type="button"
                  >
                    View review history
                  </button>
                ) : item.kind === 'PULL_REQUEST_SNAPSHOT' && onOpenPullRequest !== undefined ? (
                  <button
                    className="task-activity__link"
                    onClick={() => onOpenPullRequest(item.url)}
                    type="button"
                  >
                    Open PR #{item.number}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
          {visible.length < filtered.length ? (
            <button
              className="secondary-action task-activity__more"
              onClick={onShowMore}
              type="button"
            >
              Show older activity ({filtered.length - visible.length} remaining)
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function activityType(item: TaskActivityItem): string {
  if (item.kind.startsWith('SESSION_')) return 'Session';
  if (item.kind.startsWith('REVIEW_')) return 'Review';
  if (item.kind === 'PHASE_TRANSITION') return 'Phase';
  if (item.kind === 'PULL_REQUEST_SNAPSHOT') return 'Pull Request';
  if (item.kind === 'QUALITY_GATE') return 'Quality gate';
  return 'Artifact';
}

function activityTitle(item: TaskActivityItem): string {
  switch (item.kind) {
    case 'SESSION_STARTED':
      return `Attempt ${item.attempt} started · ${item.agentId}`;
    case 'SESSION_STOP_REQUESTED':
      return `Attempt ${item.attempt} stop requested · ${item.agentId}`;
    case 'SESSION_EXITED':
      return `Attempt ${item.attempt} process exited · ${item.agentId}`;
    case 'SESSION_FAILED':
      return `Attempt ${item.attempt} runtime failed · ${item.agentId}`;
    case 'ARTIFACT':
      return `${item.artifactKind} artifact recorded`;
    case 'QUALITY_GATE':
      return `${item.gateKind} · ${item.status}`;
    case 'REVIEW_REQUESTED':
      return 'Review requested';
    case 'REVIEW_DECIDED':
      return `Review · ${item.status}`;
    case 'PHASE_TRANSITION':
      return `${item.fromPhase} → ${item.toPhase}`;
    case 'PULL_REQUEST_SNAPSHOT':
      return `PR #${item.number} · ${item.status}${item.draft ? ' (draft)' : ''}`;
  }
}

function activityDetail(item: TaskActivityItem): string {
  switch (item.kind) {
    case 'SESSION_STARTED':
      return item.continuedFromSessionId === undefined
        ? `Session ${item.sessionId}`
        : `Session ${item.sessionId} · provider conversation continued from ${item.continuedFromSessionId}`;
    case 'SESSION_STOP_REQUESTED':
    case 'SESSION_EXITED':
    case 'SESSION_FAILED':
      return `Session ${item.sessionId}`;
    case 'ARTIFACT':
      return `${item.phase} · Artifact ${item.artifactId}${item.sessionId ? ` · Session ${item.sessionId}` : ''}`;
    case 'QUALITY_GATE':
      return `Run ${item.runId} · started ${new Date(item.startedAt).toLocaleString()}`;
    case 'REVIEW_REQUESTED':
    case 'REVIEW_DECIDED':
      return `Review ${item.reviewId}`;
    case 'PHASE_TRANSITION':
      return `Transition ${item.transitionId} · ${item.trigger}`;
    case 'PULL_REQUEST_SNAPSHOT':
      return `Latest stored PR snapshot · checks ${item.checks} · review ${item.reviewState}`;
  }
}
