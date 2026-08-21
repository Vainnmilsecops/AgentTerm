import { useEffect, useState } from 'react';

import type { AgentWorkspaceOverview, PtyRuntimeEvent } from '@agentterm/application';

import { TerminalRenderer } from './terminal-renderer';
import type { TerminalSessionClient } from './terminal-controller';
import type { TerminalConnectionState } from './terminal-controller';
import type { WorkspaceLayout, WorkspaceTerminalPane, WorkspaceTab } from './workspace-layout';
import { WorkspaceIcon } from './workspace-icons';

export interface ActiveTerminalContext {
  readonly connectionState: TerminalConnectionState;
  readonly sessionId?: string;
  readonly taskId?: string;
}

export interface WorkspaceTerminalsProps {
  readonly client?: TerminalSessionClient;
  readonly layout: WorkspaceLayout;
  readonly fontSize?: number;
  readonly onActivatePane: (paneId: string) => void;
  readonly onActivateTab: (tabId: string) => void;
  readonly onActiveConnectionStateChange?: (context: ActiveTerminalContext) => void;
  readonly onClosePane: (paneId: string) => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onOpenExternalLink?: (url: string) => void;
  readonly onOpenWorktreeFile?: (input: { readonly absolutePath: string; readonly taskId: string }) => void;
  readonly onRuntimeEvent: (event: PtyRuntimeEvent) => void;
  readonly onSplit: (sessionId: string) => void;
  readonly onStopAgent?: (sessionId: string) => void;
  readonly overview: AgentWorkspaceOverview;
}

export function WorkspaceTerminals({
  client,
  layout,
  fontSize = 14,
  onActivatePane,
  onActivateTab,
  onActiveConnectionStateChange,
  onClosePane,
  onCloseTab,
  onOpenExternalLink,
  onOpenWorktreeFile,
  onRuntimeEvent,
  onSplit,
  onStopAgent,
  overview,
}: WorkspaceTerminalsProps) {
  const [connectionStates, setConnectionStates] = useState<
    Readonly<Record<string, TerminalConnectionState>>
  >({});
  const attachedSessionIds = new Set(
    layout.tabs.flatMap((tab) => tab.panes.flatMap((pane) => pane.sessionId ?? [])),
  );
  const splitCandidate = overview.projects
    .flatMap((project) => project.tasks)
    .find(
      (task) => task.activeSession !== undefined && !attachedSessionIds.has(task.activeSession.id),
    );
  const activeTab = layout.tabs.find((tab) => tab.id === layout.activeTabId);
  const activePane = activeTab?.panes.find((pane) => pane.id === activeTab.activePaneId);
  const canSplit =
    activeTab !== undefined && activeTab.panes.length < 2 && splitCandidate !== undefined;

  useEffect(() => {
    onActiveConnectionStateChange?.(
      Object.freeze({
        connectionState:
          activePane === undefined ? 'empty' : (connectionStates[activePane.id] ?? 'empty'),
        ...(activePane === undefined
          ? {}
          : {
              ...(activePane.sessionId === undefined ? {} : { sessionId: activePane.sessionId }),
              taskId: activePane.taskId,
            }),
      }),
    );
  }, [activePane, connectionStates, onActiveConnectionStateChange]);

  return (
    <section className="terminal-workspace" aria-label="Workspace terminals">
      <header className="workspace-tabs-bar">
        <div aria-label="Workspace tabs" className="workspace-tabs" role="tablist">
          {layout.tabs.map((tab, index) => {
            const title = taskTitle(overview, tab.taskId);
            const selected = tab.id === layout.activeTabId;
            const taskPhase = taskPhaseFor(overview, tab.taskId);
            const agentId = taskAgentFor(overview, tab.taskId);
            return (
              <div className="workspace-tab" key={tab.id}>
                <button
                  aria-controls={`workspace-tab-panel-${index}`}
                  aria-selected={selected}
                  className="workspace-tab__select"
                  id={`workspace-tab-${index}`}
                  onClick={() => onActivateTab(tab.id)}
                  role="tab"
                  tabIndex={selected ? 0 : -1}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={`workspace-tab__dot workspace-tab__dot--${taskPhase.toLowerCase()}`}
                  />
                  <span className="workspace-tab__title">{title}</span>
                  <small>
                    {tab.panes.length} pane{tab.panes.length === 1 ? '' : 's'}
                  </small>
                  {agentId === undefined ? null : (
                    <span className="workspace-tab__agent-badge" data-tab-agent>
                      {agentId}
                    </span>
                  )}
                </button>
                <button
                  aria-label={`Close workspace tab: ${title}`}
                  className="workspace-tab__close"
                  onClick={() => onCloseTab(tab.id)}
                  title="Close tab and detach its terminal panes without stopping Agent Sessions."
                  type="button"
                >
                  <WorkspaceIcon name="close" size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="terminal-layout-actions">
          <span>
            Tabs <kbd>Alt+[</kbd> <kbd>Alt+]</kbd>
          </span>
          <span>
            Panes <kbd>Alt+Shift+[</kbd> <kbd>Alt+Shift+]</kbd>
          </span>
          <button
            className="terminal-split-affordance"
            disabled={!canSplit}
            onClick={() => {
              if (splitCandidate?.activeSession !== undefined) {
                onSplit(splitCandidate.activeSession.id);
              }
            }}
            title={splitActionTitle(activeTab, splitCandidate)}
            type="button"
          >
            <WorkspaceIcon name="plus" size={14} />
            Split
          </button>
        </div>
      </header>
      <div className="workspace-tab-panels">
        {layout.tabs.map((tab, tabIndex) => (
          <section
            aria-labelledby={`workspace-tab-${tabIndex}`}
            className="workspace-tab-panel"
            hidden={tab.id !== layout.activeTabId}
            id={`workspace-tab-panel-${tabIndex}`}
            key={tab.id}
            role="tabpanel"
          >
            <div
              className={`terminal-panes terminal-panes--${tab.panes.length}`}
              data-pane-count={tab.panes.length}
            >
              {tab.panes.map((pane, paneIndex) => (
                <TerminalRenderer
                  active={tab.id === layout.activeTabId && pane.id === tab.activePaneId}
                  canClose={tab.panes.length > 1}
                  {...(client === undefined ? {} : { client })}
                  closeLabel={`Close terminal pane ${paneIndex + 1}`}
                  fontSize={fontSize}
                  key={pane.id}
                  label={paneLabel(overview, pane, paneIndex)}
                  onActivate={() => onActivatePane(pane.id)}
                  onClose={() => onClosePane(pane.id)}
                  onConnectionStateChange={(state) =>
                    setConnectionStates((current) =>
                      current[pane.id] === state ? current : { ...current, [pane.id]: state },
                    )
                  }
                  {...(onOpenExternalLink !== undefined ? { onOpenExternalLink } : {})}
                  {...(onOpenWorktreeFile !== undefined ? { onOpenWorktreeFile } : {})}
                  onRuntimeEvent={onRuntimeEvent}
                  {...(onStopAgent !== undefined ? { onStopAgent } : {})}
                  paneId={pane.id}
                  {...(pane.sessionId === undefined ? {} : { sessionId: pane.sessionId })}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function paneLabel(
  overview: AgentWorkspaceOverview,
  pane: WorkspaceTerminalPane,
  paneIndex: number,
): string {
  return `Terminal pane ${paneIndex + 1} \u00b7 ${taskTitle(overview, pane.taskId)} \u00b7 ${pane.sessionId ?? 'No Session'}`;
}

function taskTitle(overview: AgentWorkspaceOverview, taskId: string): string {
  return (
    overview.projects.flatMap((project) => project.tasks).find((task) => task.task.id === taskId)
      ?.task.title ?? taskId
  );
}

function taskPhaseFor(overview: AgentWorkspaceOverview, taskId: string): string {
  return (
    overview.projects.flatMap((project) => project.tasks).find((task) => task.task.id === taskId)
      ?.task.phase ?? 'NONE'
  );
}

function taskAgentFor(overview: AgentWorkspaceOverview, taskId: string): string | undefined {
  const task = overview.projects
    .flatMap((project) => project.tasks)
    .find((task) => task.task.id === taskId);
  if (task === undefined) {
    return undefined;
  }
  const session = task.activeSession ?? task.latestSession;
  if (session === undefined) {
    return undefined;
  }
  const configured = overview.agents.find((agent) => agent.id === session.agentId);
  return configured?.id ?? session.agentId;
}

function splitActionTitle(
  activeTab: WorkspaceTab | undefined,
  splitCandidate: AgentWorkspaceOverview['projects'][number]['tasks'][number] | undefined,
): string {
  if (activeTab?.panes.length === 2) {
    return 'This workspace tab already has two terminal panes.';
  }
  if (splitCandidate?.activeSession === undefined) {
    return 'No other active Agent Session is available for a safe split.';
  }
  return `Attach ${splitCandidate.task.title} (${splitCandidate.activeSession.id}) in a second pane.`;
}
