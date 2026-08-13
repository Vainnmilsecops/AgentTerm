import { describe, expect, it } from 'vitest';

import {
  WorkspaceLayoutError,
  activateWorkspacePane,
  activateWorkspaceTab,
  closeWorkspacePane,
  closeWorkspaceTab,
  createWorkspaceLayout,
  cycleWorkspacePane,
  cycleWorkspaceTab,
  openWorkspaceTab,
  reconcileWorkspaceLayout,
  splitWorkspaceTerminal,
} from './workspace-layout';

describe('workspace tab layout', () => {
  it('opens multiple Task tabs and preserves each Task and Session context while switching', () => {
    const first = createWorkspaceLayout({ sessionId: 'session-1', taskId: 'task-1' });
    const opened = openWorkspaceTab(first, { sessionId: 'session-2', taskId: 'task-2' });
    const switched = activateWorkspaceTab(opened, 'task:task-1');
    const cycled = cycleWorkspaceTab(switched, 1);

    expect(opened.tabs).toHaveLength(2);
    expect(opened.tabs[0]).toMatchObject({
      panes: [{ sessionId: 'session-1', taskId: 'task-1' }],
      taskId: 'task-1',
    });
    expect(opened.tabs[1]).toMatchObject({
      panes: [{ sessionId: 'session-2', taskId: 'task-2' }],
      taskId: 'task-2',
    });
    expect(switched.activeTabId).toBe('task:task-1');
    expect(cycled.activeTabId).toBe('task:task-2');
  });

  it('splits the active terminal into two independently addressed panes and cycles focus', () => {
    const initial = createWorkspaceLayout({ sessionId: 'session-1', taskId: 'task-1' });
    const split = splitWorkspaceTerminal(initial, {
      sessionId: 'session-2',
      taskId: 'task-2',
    });
    const leftPaneId = split.tabs[0]!.panes[0]!.id;
    const activated = activateWorkspacePane(split, leftPaneId);
    const cycled = cycleWorkspacePane(activated, 1);

    expect(split.tabs[0]!.panes).toEqual([
      expect.objectContaining({ sessionId: 'session-1', taskId: 'task-1' }),
      expect.objectContaining({ sessionId: 'session-2', taskId: 'task-2' }),
    ]);
    expect(split.tabs[0]!.activePaneId).toBe(split.tabs[0]!.panes[1]!.id);
    expect(activated.tabs[0]!.activePaneId).toBe(leftPaneId);
    expect(cycled.tabs[0]!.activePaneId).toBe(split.tabs[0]!.panes[1]!.id);
  });

  it('rejects duplicate interactive Session consumers and a third pane', () => {
    const first = createWorkspaceLayout({ sessionId: 'session-1', taskId: 'task-1' });
    const secondTab = openWorkspaceTab(first, { sessionId: 'session-2', taskId: 'task-2' });

    expect(() =>
      splitWorkspaceTerminal(secondTab, { sessionId: 'session-1', taskId: 'task-1' }),
    ).toThrow(new WorkspaceLayoutError('SESSION_ALREADY_ATTACHED'));

    const split = splitWorkspaceTerminal(secondTab, {
      sessionId: 'session-3',
      taskId: 'task-3',
    });
    expect(() =>
      splitWorkspaceTerminal(split, { sessionId: 'session-4', taskId: 'task-4' }),
    ).toThrow(new WorkspaceLayoutError('PANE_LIMIT_REACHED'));
  });

  it('opens another tab without duplicating a Session already hosted in a split pane', () => {
    const first = createWorkspaceLayout({ sessionId: 'session-1', taskId: 'task-1' });
    const split = splitWorkspaceTerminal(first, {
      sessionId: 'session-2',
      taskId: 'task-2',
    });
    const opened = openWorkspaceTab(split, { taskId: 'task-2' });

    expect(opened.activeTabId).toBe('task:task-2');
    expect(opened.tabs[1]).toMatchObject({
      panes: [{ sessionId: undefined, taskId: 'task-2' }],
      taskId: 'task-2',
    });
    expect(
      opened.tabs.flatMap((tab) => tab.panes).filter((pane) => pane.sessionId === 'session-2'),
    ).toHaveLength(1);
  });

  it('releases pane and tab Session ownership without implying process termination', () => {
    const first = createWorkspaceLayout({ sessionId: 'session-1', taskId: 'task-1' });
    const split = splitWorkspaceTerminal(first, {
      sessionId: 'session-2',
      taskId: 'task-2',
    });
    const secondPaneId = split.tabs[0]!.panes[1]!.id;
    const closedPane = closeWorkspacePane(split, secondPaneId);
    const reopened = openWorkspaceTab(closedPane, {
      sessionId: 'session-2',
      taskId: 'task-2',
    });
    const closedTab = closeWorkspaceTab(reopened, 'task:task-1');

    expect(closedPane.tabs[0]!.panes).toHaveLength(1);
    expect(reopened.tabs).toHaveLength(2);
    expect(closedTab.tabs).toHaveLength(1);
    expect(closedTab.activeTabId).toBe('task:task-2');
    expect(closedTab.tabs[0]).toMatchObject({
      panes: [{ sessionId: 'session-2' }],
      taskId: 'task-2',
    });
  });

  it('binds a newly active Session into an existing primary pane without dropping exit output', () => {
    const empty = createWorkspaceLayout({ taskId: 'task-1' });
    const attached = reconcileWorkspaceLayout(empty, [
      { activeSessionId: 'session-new', taskId: 'task-1' },
    ]);
    const exited = reconcileWorkspaceLayout(attached, [
      { activeSessionId: undefined, taskId: 'task-1' },
    ]);

    expect(attached.tabs[0]!.panes[0]!.sessionId).toBe('session-new');
    expect(exited.tabs[0]!.panes[0]!.sessionId).toBe('session-new');
  });
});
