import { createRoot } from 'react-dom/client';
import type { AgentWorkspaceOverview, WorkspaceTaskOverview } from '@agentterm/application';
import { TaskAttentionCenter } from '../../../src/renderer/task-attention-center';
import { BoardEntry } from '../../../src/renderer/board-entry';
import type { AgentWorkspaceClient } from '../../../src/renderer/workspace-controller';
import { WorkspaceFixture } from './workspace-fixture';
import '../../../src/renderer/styles.css';

async function verify() {
  const container = document.getElementById('root')!;
  const root = createRoot(container);
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 3000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error('Attention UI timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const task: WorkspaceTaskOverview = {
    task: {
      id: 'task-2',
      projectId: 'project-2',
      title: 'Kiểm tra 👋 <script>literal</script>',
      phase: 'RUNNING',
    },
    activeSession: undefined,
    latestSession: undefined,
    previousSession: undefined,
    artifacts: [],
    autoAdvanceCount: 0,
    blocked: true,
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
  };
  let overview: AgentWorkspaceOverview = {
    agents: [],
    projects: [
      { project: { id: 'project-1', name: 'Empty project' }, tasks: [] },
      { project: { id: 'project-2', name: 'Dự án thứ hai' }, tasks: [task] },
    ],
  };
  let opened: string | undefined;
  let refreshes = 0;
  let release: (() => void) | undefined;
  let failRefresh = true;
  let failOpen = false;
  const render = () =>
    root.render(
      <TaskAttentionCenter
        overview={overview}
        onOpenTask={async (id) => {
          if (failOpen) throw new Error('secret path');
          opened = id;
        }}
        onRefresh={async () => {
          refreshes++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (failRefresh) throw new Error('private path');
          overview = { agents: [], projects: [] };
          render();
        }}
      />,
    );
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-attention-trigger]')!;
  const dialog = () => container.querySelector<HTMLDialogElement>('dialog')!;
  const action = (name: string) =>
    [...dialog().querySelectorAll('button')].find((button) => button.textContent === name)!;
  try {
    render();
    await until(() => trigger() !== null);
    if (!trigger().textContent?.includes('1')) throw new Error('Wrong task count');
    trigger().focus();
    trigger().click();
    await until(() => dialog().open);
    if (!dialog().contains(document.activeElement)) throw new Error('Opening must focus dialog');
    if (!dialog().textContent?.includes('Dự án thứ hai') || dialog().querySelector('script'))
      throw new Error('Project or literal title rendering');
    if (!dialog().textContent?.includes('Time unavailable'))
      throw new Error('Fabricated dependency timestamp');
    dialog().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }),
    );
    if (!dialog().open) throw new Error('IME dismissed dialog');
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await until(() => !dialog().open && document.activeElement === trigger());
    trigger().click();
    failOpen = true;
    action('Open task').click();
    await until(() => dialog().textContent?.includes('Task could not be opened') === true);
    if (!dialog().open || dialog().textContent?.includes('secret path'))
      throw new Error('Open error unsafe');
    failOpen = false;
    action('Open task').click();
    await until(() => opened === 'task-2' && !dialog().open);
    trigger().click();
    action('Refresh').focus();
    action('Refresh').click();
    action('Refresh').click();
    await until(
      () => refreshes === 1 && action('Refreshing…')?.getAttribute('aria-disabled') === 'true',
    );
    action('Refreshing…').click();
    if (refreshes !== 1) throw new Error('Refresh was not single-flight');
    release!();
    await until(() => dialog().textContent?.includes('Could not refresh') === true);
    if (document.activeElement !== action('Refresh'))
      throw new Error('Refresh lost keyboard focus');
    if (
      !dialog().textContent?.includes('Kiểm tra') ||
      dialog().textContent?.includes('private path')
    )
      throw new Error('Failed refresh must preserve snapshot safely');
    failRefresh = false;
    action('Refresh').click();
    await until(() => refreshes === 2);
    release!();
    await until(() => dialog().textContent?.includes('No tasks need attention') === true);
    if (!trigger().textContent?.includes('0')) throw new Error('Stale count');
    action('Close').click();
    await until(() => document.activeElement === trigger());
    let mainRequest: unknown;
    let boardActivations = 0;
    const boardClient = {
      loadWorkspace: async () => ({
        agents: [],
        projects: [{ project: { id: 'project-2', name: 'Second' }, tasks: [task] }],
      }),
      openMainWindowForTask: async (input: unknown) => {
        mainRequest = input;
      },
    } satisfies Pick<AgentWorkspaceClient, 'loadWorkspace' | 'openMainWindowForTask'>;
    root.render(
      <BoardEntry
        client={boardClient as AgentWorkspaceClient}
        onActivateTask={() => {
          boardActivations++;
        }}
      />,
    );
    await until(() => container.querySelector('[data-board-window-root]') !== null);
    await until(() => trigger() !== null);
    trigger().click();
    await until(() => dialog().open);
    action('Close').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (boardActivations !== 0) throw new Error('Modal keys leaked to board');
    action('Open task').click();
    await until(() => mainRequest !== undefined);
    if (
      JSON.stringify(mainRequest) !==
      JSON.stringify({ focusTerminal: false, selectTask: true, taskId: 'task-2' })
    )
      throw new Error('Board opened wrong task or stole terminal focus');
    let unexpectedActions = 0;
    const workspaceOverview: AgentWorkspaceOverview = {
      agents: [],
      projects: [
        {
          project: { id: 'first', name: 'First project' },
          tasks: [
            {
              ...task,
              blocked: false,
              canBeginPlanning: true,
              task: { id: 'first-task', projectId: 'first', title: 'First task', phase: 'BACKLOG' },
            },
          ],
        },
        { project: { id: 'project-2', name: 'Second project' }, tasks: [task] },
      ],
    };
    root.render(
      <WorkspaceFixture
        overview={workspaceOverview}
        onUnexpectedAction={() => {
          unexpectedActions++;
          throw new Error('Attention invoked a task mutation');
        }}
      />,
    );
    await until(() => container.querySelector('.workspace-shell') !== null);
    trigger().click();
    await until(() => dialog().open);
    const modalButton = action('Close');
    modalButton.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true, bubbles: true }),
    );
    modalButton.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'P',
        code: 'KeyP',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    if (unexpectedActions !== 0 || container.querySelector('[role="combobox"]'))
      throw new Error('Workspace shortcuts escaped attention dialog');
    const box = dialog().getBoundingClientRect();
    if (box.left < 0 || box.right > innerWidth || dialog().scrollWidth > dialog().clientWidth)
      throw new Error('Attention dialog overflows narrow window');
    action('Open task').click();
    await until(
      () =>
        !dialog().open &&
        container.querySelector('.task-header')?.textContent?.includes('Kiểm tra') === true,
    );
    await until(() => document.activeElement === container.querySelector('.task-inspector__close'));
    if (!container.querySelector('.project-board-header')?.textContent?.includes('Second project'))
      throw new Error('Wrong selected project after navigation');
    return {
      ok: true,
      message:
        'PASS: attention count, cross-project navigation, literal Unicode, focus/Escape/IME, single-flight refresh, error retention, empty state',
    };
  } finally {
    root.unmount();
  }
}
Object.assign(window, {
  inputReliabilityResult: verify().catch((error) => ({ ok: false, message: String(error) })),
});
