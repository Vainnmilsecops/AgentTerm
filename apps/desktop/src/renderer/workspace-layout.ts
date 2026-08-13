export interface WorkspaceTerminalPane {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly taskId: string;
}

export interface WorkspaceTab {
  readonly activePaneId: string;
  readonly id: string;
  readonly panes: readonly WorkspaceTerminalPane[];
  readonly taskId: string;
}

export interface WorkspaceLayout {
  readonly activeTabId: string | undefined;
  readonly tabs: readonly WorkspaceTab[];
}

export type WorkspaceLayoutFailure = 'PANE_LIMIT_REACHED' | 'SESSION_ALREADY_ATTACHED';

export class WorkspaceLayoutError extends Error {
  public readonly reason: WorkspaceLayoutFailure;

  public constructor(reason: WorkspaceLayoutFailure) {
    super(
      reason === 'PANE_LIMIT_REACHED'
        ? 'A workspace tab supports at most two terminal panes.'
        : 'The Agent Session is already attached to an interactive terminal pane.',
    );
    this.name = 'WorkspaceLayoutError';
    this.reason = reason;
  }
}

export interface OpenWorkspaceTabInput {
  readonly sessionId?: string;
  readonly taskId: string;
}

export interface SplitWorkspaceTerminalInput {
  readonly sessionId: string;
  readonly taskId: string;
}

export interface WorkspaceTaskSessionContext {
  readonly activeSessionId: string | undefined;
  readonly taskId: string;
}

export function createWorkspaceLayout(input: OpenWorkspaceTabInput): WorkspaceLayout {
  const tab = createTab(input);
  return freezeLayout({ activeTabId: tab.id, tabs: [tab] });
}

export function openWorkspaceTab(
  layout: WorkspaceLayout,
  input: OpenWorkspaceTabInput,
): WorkspaceLayout {
  const existing = layout.tabs.find((tab) => tab.taskId === input.taskId);
  if (existing !== undefined) {
    return existing.id === layout.activeTabId
      ? layout
      : freezeLayout({ activeTabId: existing.id, tabs: layout.tabs });
  }
  if (input.sessionId !== undefined) {
    assertSessionAvailable(layout, input.sessionId);
  }
  const tab = createTab(input);
  return freezeLayout({ activeTabId: tab.id, tabs: [...layout.tabs, tab] });
}

export function activateWorkspaceTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  if (layout.activeTabId === tabId || !layout.tabs.some((tab) => tab.id === tabId)) {
    return layout;
  }
  return freezeLayout({ activeTabId: tabId, tabs: layout.tabs });
}

export function closeWorkspaceTab(layout: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const index = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return layout;
  }
  const tabs = layout.tabs.filter((tab) => tab.id !== tabId);
  if (layout.activeTabId !== tabId) {
    return freezeLayout({ activeTabId: layout.activeTabId, tabs });
  }
  const replacement = tabs[Math.min(index, tabs.length - 1)];
  return freezeLayout({ activeTabId: replacement?.id, tabs });
}

export function splitWorkspaceTerminal(
  layout: WorkspaceLayout,
  input: SplitWorkspaceTerminalInput,
): WorkspaceLayout {
  const active = findActiveTab(layout);
  if (active === undefined) {
    return layout;
  }
  if (active.panes.length >= 2) {
    throw new WorkspaceLayoutError('PANE_LIMIT_REACHED');
  }
  assertSessionAvailable(layout, input.sessionId);
  const pane = freezePane({
    id: `pane:${active.taskId}:split`,
    sessionId: input.sessionId,
    taskId: input.taskId,
  });
  return replaceTab(layout, {
    ...active,
    activePaneId: pane.id,
    panes: [...active.panes, pane],
  });
}

export function activateWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  const owner = layout.tabs.find((tab) => tab.panes.some((pane) => pane.id === paneId));
  if (owner === undefined || (owner.id === layout.activeTabId && owner.activePaneId === paneId)) {
    return layout;
  }
  return replaceTab(freezeLayout({ activeTabId: owner.id, tabs: layout.tabs }), {
    ...owner,
    activePaneId: paneId,
  });
}

export function closeWorkspacePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  const owner = layout.tabs.find((tab) => tab.panes.some((pane) => pane.id === paneId));
  if (owner === undefined || owner.panes.length === 1) {
    return layout;
  }
  const index = owner.panes.findIndex((pane) => pane.id === paneId);
  const panes = owner.panes.filter((pane) => pane.id !== paneId);
  const activePaneId =
    owner.activePaneId === paneId
      ? panes[Math.min(index, panes.length - 1)]!.id
      : owner.activePaneId;
  return replaceTab(layout, { ...owner, activePaneId, panes });
}

export function cycleWorkspaceTab(layout: WorkspaceLayout, delta: -1 | 1): WorkspaceLayout {
  if (layout.tabs.length < 2 || layout.activeTabId === undefined) {
    return layout;
  }
  const currentIndex = layout.tabs.findIndex((tab) => tab.id === layout.activeTabId);
  const next = layout.tabs[(currentIndex + delta + layout.tabs.length) % layout.tabs.length]!;
  return activateWorkspaceTab(layout, next.id);
}

export function cycleWorkspacePane(layout: WorkspaceLayout, delta: -1 | 1): WorkspaceLayout {
  const active = findActiveTab(layout);
  if (active === undefined || active.panes.length < 2) {
    return layout;
  }
  const currentIndex = active.panes.findIndex((pane) => pane.id === active.activePaneId);
  const next = active.panes[(currentIndex + delta + active.panes.length) % active.panes.length]!;
  return activateWorkspacePane(layout, next.id);
}

export function findActiveWorkspaceTab(layout: WorkspaceLayout): WorkspaceTab | undefined {
  return findActiveTab(layout);
}

export function findActiveWorkspacePane(
  layout: WorkspaceLayout,
): WorkspaceTerminalPane | undefined {
  const tab = findActiveTab(layout);
  return tab?.panes.find((pane) => pane.id === tab.activePaneId);
}

export function reconcileWorkspaceLayout(
  layout: WorkspaceLayout,
  tasks: readonly WorkspaceTaskSessionContext[],
): WorkspaceLayout {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const retained = layout.tabs.filter((tab) => taskById.has(tab.taskId));
  const pruned = retained.map((tab) => {
    const panes = tab.panes.filter((pane) => taskById.has(pane.taskId));
    return freezeTab({
      ...tab,
      activePaneId: panes.some((pane) => pane.id === tab.activePaneId)
        ? tab.activePaneId
        : panes[0]!.id,
      panes,
    });
  });
  const tabs = pruned.map((tab) => {
    const desiredSessionId = taskById.get(tab.taskId)?.activeSessionId;
    const primary = tab.panes[0];
    if (
      desiredSessionId === undefined ||
      primary === undefined ||
      primary.sessionId === desiredSessionId ||
      pruned.some((candidate) =>
        candidate.panes.some(
          (pane) => pane.id !== primary.id && pane.sessionId === desiredSessionId,
        ),
      )
    ) {
      return tab;
    }
    return freezeTab({
      ...tab,
      panes: [freezePane({ ...primary, sessionId: desiredSessionId }), ...tab.panes.slice(1)],
    });
  });
  const activeTabId = tabs.some((tab) => tab.id === layout.activeTabId)
    ? layout.activeTabId
    : tabs[0]?.id;
  return freezeLayout({ activeTabId, tabs });
}

function createTab(input: OpenWorkspaceTabInput): WorkspaceTab {
  const id = `task:${input.taskId}`;
  const pane = freezePane({
    id: `pane:${input.taskId}:primary`,
    sessionId: input.sessionId,
    taskId: input.taskId,
  });
  return freezeTab({ activePaneId: pane.id, id, panes: [pane], taskId: input.taskId });
}

function findActiveTab(layout: WorkspaceLayout): WorkspaceTab | undefined {
  return layout.tabs.find((tab) => tab.id === layout.activeTabId);
}

function assertSessionAvailable(layout: WorkspaceLayout, sessionId: string): void {
  if (layout.tabs.some((tab) => tab.panes.some((pane) => pane.sessionId === sessionId))) {
    throw new WorkspaceLayoutError('SESSION_ALREADY_ATTACHED');
  }
}

function replaceTab(layout: WorkspaceLayout, replacement: WorkspaceTab): WorkspaceLayout {
  return freezeLayout({
    activeTabId: layout.activeTabId,
    tabs: layout.tabs.map((tab) => (tab.id === replacement.id ? freezeTab(replacement) : tab)),
  });
}

function freezePane(pane: WorkspaceTerminalPane): WorkspaceTerminalPane {
  return Object.freeze({ ...pane });
}

function freezeTab(tab: WorkspaceTab): WorkspaceTab {
  return Object.freeze({
    ...tab,
    panes: Object.freeze(tab.panes.map((pane) => freezePane(pane))),
  });
}

function freezeLayout(layout: WorkspaceLayout): WorkspaceLayout {
  return Object.freeze({
    activeTabId: layout.activeTabId,
    tabs: Object.freeze(layout.tabs.map((tab) => freezeTab(tab))),
  });
}
