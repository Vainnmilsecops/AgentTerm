import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { TaskActivityTimeline } from '@agentterm/application';

import { filterTaskActivity, TaskActivityTimelineView } from './task-activity-timeline';

const timeline: TaskActivityTimeline = {
  taskId: 'task-1',
  items: [
    {
      id: 'session:1:1',
      kind: 'SESSION_STARTED',
      occurredAt: 10,
      agentId: 'codex',
      attempt: 1,
      continuedFromSessionId: undefined,
      sessionId: 'session-1',
    },
    {
      id: 'artifact:1',
      kind: 'ARTIFACT',
      occurredAt: 20,
      artifactId: 'artifact-1',
      artifactKind: 'plan',
      phase: 'PLANNING',
      sessionId: 'session-1',
    },
    {
      id: 'pr:1',
      kind: 'PULL_REQUEST_SNAPSHOT',
      occurredAt: 30,
      observedAt: 30,
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
      status: 'OPEN',
      draft: true,
      checks: 'PENDING',
      reviewState: 'NONE',
    },
  ],
};

describe('TaskActivityTimelineView', () => {
  it('filters by evidence type without changing the persisted timeline', () => {
    expect(filterTaskActivity(timeline.items, 'SESSION').map((item) => item.id)).toEqual([
      'session:1:1',
    ]);
    expect(filterTaskActivity(timeline.items, 'ARTIFACT').map((item) => item.id)).toEqual([
      'artifact:1',
    ]);
    expect(timeline.items).toHaveLength(3);
  });

  it('renders accessible event context, evidence navigation and a PR snapshot label', () => {
    const html = renderToStaticMarkup(
      createElement(TaskActivityTimelineView, {
        filter: 'ALL',
        onFilterChange: vi.fn(),
        onOpenPullRequest: vi.fn(),
        onReveal: vi.fn(),
        onShowMore: vi.fn(),
        timeline,
        visibleCount: 20,
      }),
    );
    expect(html).toContain('Task activity');
    expect(html).toContain('Attempt 1');
    expect(html).toContain('codex');
    expect(html).toContain('plan');
    expect(html).toContain('Open PR #42');
    expect(html).toContain('Latest stored PR snapshot');
    expect(html).toContain('View artifact history');
    expect(html).toContain('aria-pressed="true"');
  });

  it('shows a clear empty state and offers progressive disclosure for long history', () => {
    const empty = renderToStaticMarkup(
      createElement(TaskActivityTimelineView, {
        filter: 'REVIEW',
        onFilterChange: vi.fn(),
        onOpenPullRequest: vi.fn(),
        onReveal: vi.fn(),
        onShowMore: vi.fn(),
        timeline,
        visibleCount: 20,
      }),
    );
    expect(empty).toContain('No review activity');
    const limited = renderToStaticMarkup(
      createElement(TaskActivityTimelineView, {
        filter: 'ALL',
        onFilterChange: vi.fn(),
        onOpenPullRequest: vi.fn(),
        onReveal: vi.fn(),
        onShowMore: vi.fn(),
        timeline,
        visibleCount: 1,
      }),
    );
    expect(limited).toContain('Show older activity');
  });
});
