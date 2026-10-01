import { createRoot } from 'react-dom/client';

import type { TaskActivityPageInput, TaskActivityTimeline } from '@agentterm/application';

import { TaskActivityTimeline as Timeline } from '../../../src/renderer/task-activity-timeline';
import type { AgentWorkspaceClient } from '../../../src/renderer/workspace-controller';
import '../../../src/renderer/styles.css';

const newer = {
  id: 'phase:newer',
  kind: 'PHASE_TRANSITION' as const,
  occurredAt: 20,
  fromPhase: 'BACKLOG' as const,
  toPhase: 'PLANNING' as const,
  transitionId: 'newer',
  trigger: 'manual' as const,
};
const older = {
  id: 'phase:older',
  kind: 'PHASE_TRANSITION' as const,
  occurredAt: 10,
  fromPhase: 'PLANNING' as const,
  toPhase: 'RUNNING' as const,
  transitionId: 'older',
  trigger: 'manual' as const,
};
const first: TaskActivityTimeline = {
  taskId: 'task-1',
  items: [newer],
  nextCursor: { id: newer.id, occurredAt: newer.occurredAt },
};
const second: TaskActivityTimeline = { taskId: 'task-1', items: [older] };

async function verify(): Promise<void> {
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const calls: TaskActivityPageInput[] = [];
  let failOlder = true;
  let holdOlder = false;
  let resolveOlder: ((page: TaskActivityTimeline) => void) | undefined;
  const client = {
    loadTaskActivity: async (input: TaskActivityPageInput) => {
      calls.push(input);
      if (input.filter === 'SESSION') return { taskId: input.taskId, items: [] };
      if (input.cursor === undefined) return first;
      if (failOlder) {
        failOlder = false;
        throw new Error('private error');
      }
      if (holdOlder)
        return new Promise<TaskActivityTimeline>((resolve) => {
          resolveOlder = resolve;
        });
      return second;
    },
  } as AgentWorkspaceClient;
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 3_000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error('Task activity UI timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((element) =>
      element.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;

  try {
    root.render(
      <Timeline
        client={client}
        onOpenPullRequest={undefined}
        onReveal={() => undefined}
        refreshKey={{}}
        taskId="task-1"
      />,
    );
    await until(() => button('Show older activity') !== undefined);
    if (calls.length !== 1 || calls[0]?.filter !== 'ALL' || calls[0].cursor !== undefined)
      throw new Error('Initial read did not request the first bounded page');
    button('Show older activity')!.click();
    await until(() => button('Retry older activity') !== undefined);
    if (
      !container.querySelector('[role="alert"]') ||
      container.textContent?.includes('private error')
    )
      throw new Error('Older-page failure was not safely recoverable');
    button('Retry older activity')!.click();
    await until(() => container.querySelectorAll('.task-activity__item').length === 2);
    if (
      calls[2]?.cursor?.id !== newer.id ||
      document.activeElement?.textContent?.includes('PLANNING → RUNNING') !== true
    )
      throw new Error('Older page cursor or keyboard focus was lost');
    button('Sessions')!.click();
    await until(() => container.textContent?.includes('No session activity') === true);
    if (calls.at(-1)?.filter !== 'SESSION' || calls.at(-1)?.cursor !== undefined)
      throw new Error('Filter did not start a fresh server-side read');
    button('All')!.click();
    await until(() => button('Show older activity') !== undefined);
    holdOlder = true;
    button('Show older activity')!.click();
    await until(() => resolveOlder !== undefined);
    button('Sessions')!.click();
    await until(() => container.textContent?.includes('No session activity') === true);
    resolveOlder!(second);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (
      container.textContent?.includes('Transition older') ||
      container.querySelectorAll('.task-activity__item').length !== 0
    )
      throw new Error('A stale older-page response reopened another filter');
  } finally {
    root.unmount();
  }
}

declare global {
  interface Window {
    inputReliabilityResult: Promise<{ ok: boolean; message: string }>;
  }
}

window.inputReliabilityResult = verify().then(
  () => ({ ok: true, message: 'PASS task activity pagination smoke' }),
  (error: unknown) => ({
    ok: false,
    message: `FAIL task activity pagination smoke: ${String(error)}`,
  }),
);
