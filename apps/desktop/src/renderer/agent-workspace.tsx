import { useEffect, useRef, useState } from 'react';

import type {
  AgentWorkspaceOverview,
  PullRequestBranchReadinessFailure,
  TaskFileChange,
  TaskFileDiff,
  UpdateApplicationSettingsInput,
  WorkspaceProjectOverview,
  WorkspaceTaskOverview,
} from '@agentterm/application';

import { WorkspaceCommandPalette } from './command-palette';
import { WorkspaceTerminals } from './workspace-terminals';
import { WorkspaceFooterStatus } from './workspace-footer-status';
import { WorkspaceSettingsGear } from './workspace-settings-gear';
import { SettingsPanel } from './settings-panel';
import { EmptyState } from './empty-state';
import { ContextCard } from './context-card';
import { ToastStack } from './toast-stack';
import { ArtifactProducer } from './artifact-producer';
import { DependencyEditor } from './dependency-editor';
import { QualityGateConfiguration } from './quality-gate-config';
import { createToastRegistry, toastForAction, type Toast } from './toast';
import { readPersistedLayout, writePersistedLayout } from './workspace-layout-persistence';
import {
  DEFAULT_TERMINAL_HEIGHT,
  MAX_TERMINAL_VIEWPORT_OFFSET,
  MIN_TERMINAL_HEIGHT,
  resizeTerminalHeight,
} from './terminal-pane-size';
import {
  buildWorkspaceCommands,
  initialCommandPaletteState,
  reduceCommandPalette,
  resolveWorkspaceGlobalShortcut,
  type CommandPaletteAction,
  type WorkspaceCommand,
  type WorkspaceFocusTarget,
} from './workspace-command-palette';
import {
  WorkspaceController,
  type AgentWorkspaceClient,
  type WorkspaceActionKind,
  type WorkspaceSnapshot,
} from './workspace-controller';

export interface AgentWorkspaceProps {
  readonly client?: AgentWorkspaceClient;
}

export interface AgentWorkspaceViewProps extends AgentWorkspaceProps {
  readonly onAcceptPlan: () => void;
  readonly onApproveReview: () => void;
  readonly onBeginPlanning: () => void;
  readonly onCreatePullRequest: () => void;
  readonly onCreateTask: (input: {
    readonly brief: string;
    readonly projectId: string;
    readonly title: string;
  }) => boolean | Promise<boolean>;
  readonly onProduceArtifact: (input: {
    readonly content: string;
    readonly createdAt: number;
    readonly id: string;
    readonly sessionId: string | undefined;
    readonly taskId: string;
  }) => void;
  readonly onCloseWorkspacePane: (paneId: string) => void;
  readonly onCloseWorkspaceTab: (tabId: string) => void;
  readonly onCycleWorkspacePane: (delta: -1 | 1) => void;
  readonly onCycleWorkspaceTab: (delta: -1 | 1) => void;
  readonly onPushTaskBranch: () => void;
  readonly onOpenProject: () => void;
  readonly onRefreshPullRequest: () => void;
  readonly onRefresh: () => void;
  readonly onRequestChanges: () => void;
  readonly onRequestReview: () => void;
  readonly onRetry: () => void;
  readonly onRetryTask: () => void;
  readonly onRunQualityGate: (gateId: string) => void;
  readonly onSelectAgent?: (agentId: string) => void;
  readonly onSaveSettings?: (input: UpdateApplicationSettingsInput) => void;
  readonly onSelectTaskChange: (change: TaskFileChange) => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onSelectWorkspacePane: (paneId: string) => void;
  readonly onSelectWorkspaceTab: (tabId: string) => void;
  readonly onSplitTerminal: (sessionId: string) => void;
  readonly onStartTask: () => void;
  readonly onStartPlanning: () => void;
  readonly snapshot: WorkspaceSnapshot;
}

export function AgentWorkspace({ client }: AgentWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(
    client === undefined
      ? { kind: 'error', message: 'Workspace connection is not available.' }
      : { kind: 'loading' },
  );
  const [controller, setController] = useState<WorkspaceController | undefined>();

  useEffect(() => {
    if (client === undefined) {
      setController(undefined);
      setSnapshot({ kind: 'error', message: 'Workspace connection is not available.' });
      return;
    }
    const nextController = new WorkspaceController(client, setSnapshot);
    setController(nextController);
    void nextController.load();
    return () => nextController.dispose();
  }, [client]);

  return (
    <AgentWorkspaceView
      {...(client === undefined ? {} : { client })}
      onAcceptPlan={() => void controller?.acceptSelectedPlan()}
      onApproveReview={() => void controller?.approveSelectedTaskReview()}
      onBeginPlanning={() => void controller?.beginSelectedTaskPlanning()}
      onCreatePullRequest={() => void controller?.createSelectedTaskPullRequest()}
      onCreateTask={(input) => controller?.createTask(input) ?? false}
      onProduceArtifact={(input) => void controller?.produceArtifact(input)}
      onCloseWorkspacePane={(paneId) => controller?.closeWorkspacePane(paneId)}
      onCloseWorkspaceTab={(tabId) => controller?.closeWorkspaceTab(tabId)}
      onCycleWorkspacePane={(delta) => controller?.cycleWorkspacePane(delta)}
      onCycleWorkspaceTab={(delta) => controller?.cycleWorkspaceTab(delta)}
      onRefresh={() => void controller?.refresh()}
      onPushTaskBranch={() => void controller?.pushSelectedTaskBranch()}
      onOpenProject={() => void controller?.openProject()}
      onRefreshPullRequest={() => void controller?.refreshSelectedTaskPullRequest()}
      onRequestChanges={() => void controller?.requestSelectedTaskChanges()}
      onRequestReview={() => void controller?.requestSelectedTaskReview()}
      onRetry={() => void controller?.load()}
      onRetryTask={() => void controller?.retrySelectedTask()}
      onRunQualityGate={(gateId) => void controller?.runSelectedQualityGate(gateId)}
      onSelectAgent={(agentId) => controller?.selectAgent(agentId)}
      onSaveSettings={(input) => void controller?.saveSettings(input)}
      onSelectTaskChange={(change) => void controller?.selectTaskChange(change)}
      onSelectTask={(taskId) => controller?.selectTask(taskId)}
      onSelectWorkspacePane={(paneId) => controller?.selectWorkspacePane(paneId)}
      onSelectWorkspaceTab={(tabId) => controller?.selectWorkspaceTab(tabId)}
      onSplitTerminal={(sessionId) => controller?.splitSelectedTerminal(sessionId)}
      onStartTask={() => void controller?.startSelectedTask()}
      onStartPlanning={() => void controller?.startSelectedPlanning()}
      snapshot={snapshot}
    />
  );
}

export function AgentWorkspaceView({
  client,
  onAcceptPlan,
  onApproveReview,
  onBeginPlanning,
  onCreatePullRequest,
  onCreateTask,
  onProduceArtifact,
  onCloseWorkspacePane,
  onCloseWorkspaceTab,
  onCycleWorkspacePane,
  onCycleWorkspaceTab,
  onRefresh,
  onPushTaskBranch,
  onOpenProject,
  onRefreshPullRequest,
  onRequestChanges,
  onRequestReview,
  onRetry,
  onRetryTask,
  onRunQualityGate,
  onSelectAgent,
  onSaveSettings,
  onSelectTaskChange,
  onSelectTask,
  onSelectWorkspacePane,
  onSelectWorkspaceTab,
  onSplitTerminal,
  onStartTask,
  onStartPlanning,
  snapshot,
}: AgentWorkspaceViewProps) {
  const [paletteState, setPaletteState] = useState(initialCommandPaletteState);
  const [commandRecents, setCommandRecents] = useState<readonly string[]>([]);
  const [layout, setLayout] = useState(() => readPersistedLayout());
  const toastRegistryRef = useRef(createToastRegistry());
  const [toasts, setToasts] = useState<readonly Toast[]>(() =>
    toastRegistryRef.current.getToasts(),
  );
  const sidebarDrag = useRef<{ pointerId: number; pointerX: number; width: number } | undefined>(
    undefined,
  );
  const sidebarResizeFrame = useRef<number | undefined>(undefined);
  const paletteReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(
    () => () => {
      if (sidebarResizeFrame.current !== undefined) {
        window.cancelAnimationFrame(sidebarResizeFrame.current);
      }
    },
    [],
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const next = toastRegistryRef.current.getToasts();
      setToasts((current) =>
        current.length === next.length && current.every((t, i) => t.id === next[i]?.id)
          ? current
          : next,
      );
    }, 200);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    writePersistedLayout(layout);
  }, [layout]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', layout.theme);
  }, [layout.theme]);

  useEffect(() => {
    if (snapshot.kind !== 'ready') {
      return;
    }
    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      const shortcut = resolveWorkspaceGlobalShortcut(event);
      if (shortcut === undefined) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (shortcut === 'open-palette') {
        paletteReturnFocus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setPaletteState((current) => reduceCommandPalette(current, { kind: 'OPEN' }, 1));
        return;
      }
      if (shortcut === 'previous-tab' || shortcut === 'next-tab') {
        onCycleWorkspaceTab(shortcut === 'previous-tab' ? -1 : 1);
        scheduleTerminalFocus();
        return;
      }
      if (shortcut === 'previous-pane' || shortcut === 'next-pane') {
        onCycleWorkspacePane(shortcut === 'previous-pane' ? -1 : 1);
        scheduleTerminalFocus();
        return;
      }
      setPaletteState(initialCommandPaletteState);
      focusWorkspaceTarget(shortcut.replace('focus-', '') as WorkspaceFocusTarget);
    };
    const handleMnemonicKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey === false || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        onBeginPlanning();
        return;
      }
      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        onStartTask();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        if (event.shiftKey) {
          onRequestReview();
        } else {
          onRetryTask();
        }
        return;
      }
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        onAcceptPlan();
        return;
      }
      if (event.key === 'c' || event.key === 'C') {
        event.preventDefault();
        onRequestChanges();
        return;
      }
      if (event.key === 'd' || event.key === 'D') {
        event.preventDefault();
        onApproveReview();
        return;
      }
    };
    document.addEventListener('keydown', handleGlobalKeyDown, true);
    document.addEventListener('keydown', handleMnemonicKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown, true);
      document.removeEventListener('keydown', handleMnemonicKeyDown, true);
    };
  }, [snapshot.kind]);

  if (snapshot.kind === 'loading') {
    return <WorkspaceMessage eyebrow="Workspace" message="Loading workspace…" />;
  }
  if (snapshot.kind === 'error') {
    return (
      <WorkspaceMessage eyebrow="Workspace unavailable" message={snapshot.message}>
        <button className="secondary-action" onClick={onRetry} type="button">
          Retry
        </button>
      </WorkspaceMessage>
    );
  }
  const selected = findTask(snapshot, snapshot.selectedTaskId);
  const selectedProject = findProject(snapshot, selected?.task.projectId);
  const actionsBusy = snapshot.activeAction !== undefined;
  const planningAttempt = selected?.canStartPlanning || selected?.canRevisePlan;
  const firstExecutionAfterPlan =
    selected === undefined ? false : isFirstExecutionAfterPlan(selected);
  const focusTarget = (target: WorkspaceFocusTarget): void => focusWorkspaceTarget(target);
  const commands = buildWorkspaceCommands(
    {
      actionBusy: actionsBusy,
      qualityGates: snapshot.qualityGates ?? [],
      selectedAgentId: snapshot.selectedAgentId,
      selectedTask:
        selected === undefined
          ? undefined
          : {
              canRequestReview: selected.canRequestReview,
              canRetryExecution: selected.canRetryExecution,
              canRevisePlan: selected.canRevisePlan,
              canRunQualityGate: selected.canRunQualityGate,
              canStartExecution: selected.canStartExecution,
              canStartPlanning: selected.canStartPlanning,
              id: selected.task.id,
            },
      tasks: snapshot.overview.projects.flatMap((project) =>
        project.tasks.map(({ task }) => ({
          id: task.id,
          projectName: project.project.name,
          title: task.title,
        })),
      ),
    },
    {
      focus: focusTarget,
      requestReview: onRequestReview,
      retryExecution: onRetryTask,
      runQualityGate: onRunQualityGate,
      selectTask: (taskId) => {
        onSelectTask(taskId);
        focusTarget('workspace');
      },
      startExecution: onStartTask,
      startPlanning: onStartPlanning,
    },
  );

  const closePalette = (restoreFocus: boolean): void => {
    setPaletteState(initialCommandPaletteState);
    if (restoreFocus) {
      const returnTarget = paletteReturnFocus.current;
      queueMicrotask(() => returnTarget?.focus({ preventScroll: true }));
    }
  };

  const handlePaletteAction = (action: CommandPaletteAction, resultCount: number): void => {
    if (action.kind === 'CLOSE') {
      closePalette(true);
      return;
    }
    setPaletteState((current) => reduceCommandPalette(current, action, resultCount));
  };

  const runPaletteCommand = (command: WorkspaceCommand): void => {
    setCommandRecents((current) => {
      const filtered = current.filter((id) => id !== command.id);
      return [command.id, ...filtered].slice(0, 5);
    });
    const restoreFocus = command.category !== 'Navigate' && !command.id.startsWith('task:');
    closePalette(restoreFocus);
    void Promise.resolve(command.run()).catch(() => undefined);
  };

  const openPalette = (): void => {
    paletteReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteState((current) => reduceCommandPalette(current, { kind: 'OPEN' }, commands.length));
  };

  return (
    <main
      className={`workspace-shell${layout.sidebarCollapsed ? ' workspace-shell--sidebar-collapsed' : ''}`}
      style={{ '--sidebar-width': `${String(layout.sidebarWidth)}px` } as React.CSSProperties}
    >
      <a className="skip-link" href="#workspace-main">
        Skip to Task workspace
      </a>
      <WorkspaceSidebar
        busy={snapshot.onboardingBusy ?? false}
        error={snapshot.actionError}
        onCreateTask={onCreateTask}
        onOpenProject={onOpenProject}
        onToggleCollapsed={() =>
          setLayout((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))
        }
        sidebarCollapsed={layout.sidebarCollapsed}
        settingsPanel={
          snapshot.settings === undefined || onSaveSettings === undefined ? undefined : (
            <SettingsPanel
              error={snapshot.settingsError}
              onSave={onSaveSettings}
              saving={snapshot.settingsSaving ?? false}
              view={snapshot.settings}
            />
          )
        }
        qualityGateConfig={
          <QualityGateConfiguration
            busy={snapshot.activeAction !== undefined}
            error={undefined}
            gates={snapshot.qualityGates ?? []}
            onRegister={async (input) => {
              await controller?.registerQualityGate(input);
              return Object.freeze({
                command: Object.freeze({
                  arguments: Object.freeze([...input.arguments]),
                  executablePath: input.executablePath,
                }),
                id: input.id,
                kind: input.kind,
                timeoutMs: input.timeoutMs,
              });
            }}
            onUnregister={async (gateId) => {
              await controller?.unregisterQualityGate(gateId);
              return true;
            }}
          />
        }
        projects={snapshot.overview.projects}
        selectedTaskId={snapshot.selectedTaskId}
        onSelectTask={onSelectTask}
      />
      <div
        aria-label="Resize Settings and Task sidebar"
        aria-orientation="vertical"
        aria-valuemax={520}
        aria-valuemin={240}
        aria-valuenow={layout.sidebarWidth}
        className="sidebar-resize-handle"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setLayout((current) => ({
            ...current,
            sidebarWidth: Math.min(
              520,
              Math.max(240, current.sidebarWidth + (event.key === 'ArrowRight' ? 24 : -24)),
            ),
          }));
        }}
        onLostPointerCapture={() => {
          sidebarDrag.current = undefined;
        }}
        onPointerDown={(event) => {
          sidebarDrag.current = {
            pointerId: event.pointerId,
            pointerX: event.clientX,
            width: layout.sidebarWidth,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = sidebarDrag.current;
          if (active === undefined || active.pointerId !== event.pointerId) return;
          const nextWidth = Math.min(
            520,
            Math.max(240, active.width + event.clientX - active.pointerX),
          );
          if (sidebarResizeFrame.current !== undefined) {
            window.cancelAnimationFrame(sidebarResizeFrame.current);
          }
          sidebarResizeFrame.current = window.requestAnimationFrame(() => {
            setLayout((current) => ({ ...current, sidebarWidth: nextWidth }));
            sidebarResizeFrame.current = undefined;
          });
        }}
        onPointerUp={(event) => {
          if (sidebarDrag.current?.pointerId !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          sidebarDrag.current = undefined;
        }}
        role="separator"
        tabIndex={0}
      >
        <span aria-hidden="true" />
      </div>
      {selected === undefined || selectedProject === undefined ? (
        <WorkspaceMessage
          eyebrow={snapshot.overview.projects.length === 0 ? 'Empty workspace' : 'No Task selected'}
          message={
            snapshot.overview.projects.length === 0
              ? 'No Projects yet. Open a local Git Project to begin.'
              : 'Choose a Task from the sidebar to inspect its execution state.'
          }
        >
          {snapshot.overview.projects.length === 0 ? (
            <button
              className="primary-action"
              disabled={snapshot.onboardingBusy ?? false}
              onClick={onOpenProject}
              type="button"
            >
              Open Project
            </button>
          ) : null}
        </WorkspaceMessage>
      ) : (
        <section
          className="workspace-main"
          aria-label="Selected Task workspace"
          id="workspace-main"
          tabIndex={-1}
        >
          <header className="task-header">
            <div className="task-header__identity">
              <p className="breadcrumb">{selectedProject.project.name}</p>
              <ContextCard
                description={
                  selected.activeSession === undefined
                    ? 'No active Agent Session is attached to this task.'
                    : `${selected.activeSession.status} on ${formatAgentIdentity(snapshot.overview, selected.activeSession.agentId)}`
                }
                {...(selected.activeSession === undefined
                  ? {}
                  : {
                      primaryAction: {
                        label: 'Focus terminal',
                        onClick: () => focusWorkspaceTarget('terminal'),
                      },
                    })}
                metadata={[
                  { label: 'Task', value: selected.task.id },
                  { label: 'Phase', value: selected.task.phase },
                  ...(selected.activeSession === undefined
                    ? []
                    : [
                        {
                          label: 'Session',
                          value: selected.activeSession.id,
                        },
                        {
                          label: 'Attempts',
                          value: String(selected.reviewHistory.length),
                        },
                      ]),
                  ...(selected.latestReview?.codeState.branchName === undefined
                    ? []
                    : [
                        {
                          label: 'Branch',
                          value: selected.latestReview.codeState.branchName,
                        },
                      ]),
                ]}
                title={selected.task.title}
                trigger={<h2 className="task-header__title-trigger">{selected.task.title}</h2>}
              >
                <span className="context-card__hint">Hover for metadata</span>
              </ContextCard>
              <p className="task-id">{selected.task.id}</p>
            </div>
            <div className="task-actions" aria-busy={actionsBusy}>
              {selected.canBeginPlanning ? (
                <button
                  className="primary-action button-with-hint"
                  data-action-hint="begin-planning"
                  disabled={actionsBusy}
                  onClick={onBeginPlanning}
                  type="button"
                >
                  <span>
                    {isSelectedAction(snapshot, selected.task.id, 'begin-planning')
                      ? 'Entering planning…'
                      : 'Begin planning'}
                  </span>
                  <kbd className="button-hint" aria-hidden="true">
                    Alt+P
                  </kbd>
                </button>
              ) : null}
              <button
                aria-label="Open command palette"
                className="command-palette-trigger"
                onClick={openPalette}
                title="Open command palette (Ctrl+Shift+P)"
                type="button"
              >
                <span>Commands</span>
                <kbd>Ctrl+Shift+P</kbd>
              </button>
              <label className="agent-selector">
                <span>Agent for next attempt</span>
                <select
                  aria-label="Coding agent"
                  disabled={
                    actionsBusy ||
                    (!selected.canStartExecution &&
                      !selected.canRetryExecution &&
                      !selected.canStartPlanning &&
                      !selected.canRevisePlan) ||
                    snapshot.overview.agents.every((agent) => agent.kind !== 'available')
                  }
                  title="Used for the next planning or execution attempt."
                  onChange={(event) => onSelectAgent?.(event.currentTarget.value)}
                  value={snapshot.selectedAgentId ?? ''}
                >
                  {snapshot.selectedAgentId === undefined ? (
                    <option value="">No available agent</option>
                  ) : null}
                  {snapshot.overview.agents.map((agent) => (
                    <option disabled={agent.kind === 'unavailable'} key={agent.id} value={agent.id}>
                      {formatAgentOption(agent)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="secondary-action" onClick={onRefresh} type="button">
                Refresh
              </button>
              <button
                className="primary-action button-with-hint"
                data-action-hint={
                  planningAttempt
                    ? 'start-planning'
                    : selected.canRetryExecution
                      ? 'retry-task'
                      : 'start-task'
                }
                disabled={!canStartAttempt(selected, snapshot.selectedAgentId) || actionsBusy}
                onClick={
                  planningAttempt
                    ? onStartPlanning
                    : selected.canRetryExecution
                      ? onRetryTask
                      : onStartTask
                }
                title={startAttemptTitle(selected, snapshot.selectedAgentId)}
                type="button"
              >
                <span>
                  {isAttemptActionForTask(snapshot, selected.task.id)
                    ? planningAttempt
                      ? 'Planning…'
                      : selected.canRetryExecution
                        ? firstExecutionAfterPlan
                          ? 'Starting…'
                          : 'Retrying…'
                        : 'Starting…'
                    : planningAttempt
                      ? selected.latestPlan === undefined
                        ? 'Start planning'
                        : 'Revise plan'
                      : selected.canRetryExecution
                        ? firstExecutionAfterPlan
                          ? 'Start execution'
                          : 'Retry execution'
                        : 'Start execution'}
                </span>
                <kbd className="button-hint" aria-hidden="true">
                  {planningAttempt ? 'Alt+P' : selected.canRetryExecution ? 'Alt+R' : 'Alt+S'}
                </kbd>
              </button>
              {selected.canAcceptPlan && selected.latestPlan !== undefined ? (
                <button
                  className="primary-action button-with-hint"
                  data-action-hint="accept-plan"
                  disabled={actionsBusy}
                  onClick={onAcceptPlan}
                  type="button"
                >
                  <span>
                    {isSelectedAction(snapshot, selected.task.id, 'accept-plan')
                      ? 'Accepting Plan…'
                      : 'Accept Plan and enter RUNNING'}
                  </span>
                  <kbd className="button-hint" aria-hidden="true">
                    Alt+A
                  </kbd>
                </button>
              ) : null}
              {selected.canRequestReview ? (
                <button
                  className="secondary-action button-with-hint"
                  data-action-hint="request-review"
                  disabled={actionsBusy}
                  onClick={onRequestReview}
                  type="button"
                >
                  <span>
                    {isSelectedAction(snapshot, selected.task.id, 'request-review')
                      ? 'Starting review...'
                      : 'Start review'}
                  </span>
                  <kbd className="button-hint" aria-hidden="true">
                    Alt+Shift+R
                  </kbd>
                </button>
              ) : null}
              {selected.canRequestChanges ? (
                <button
                  className="secondary-action button-with-hint"
                  data-action-hint="request-changes"
                  disabled={actionsBusy}
                  onClick={onRequestChanges}
                  type="button"
                >
                  <span>
                    {isSelectedAction(snapshot, selected.task.id, 'request-changes')
                      ? 'Requesting changes...'
                      : 'Request changes'}
                  </span>
                  <kbd className="button-hint" aria-hidden="true">
                    Alt+Shift+C
                  </kbd>
                </button>
              ) : null}
              {selected.canApproveReview ? (
                <button
                  className="primary-action button-with-hint"
                  data-action-hint="approve-review"
                  disabled={actionsBusy}
                  onClick={() => {
                    onApproveReview();
                    toastRegistryRef.current.push(
                      toastForAction('Approve and mark done', 'success'),
                    );
                  }}
                  type="button"
                >
                  <span>
                    {isSelectedAction(snapshot, selected.task.id, 'approve-review')
                      ? 'Approving...'
                      : 'Approve and mark done'}
                  </span>
                  <kbd className="button-hint" aria-hidden="true">
                    Alt+D
                  </kbd>
                </button>
              ) : null}
              <WorkspaceSettingsGear layout={layout} onLayoutChange={setLayout} />
            </div>
          </header>

          {snapshot.actionError === undefined ? null : (
            <p className="inline-error" role="alert">
              {snapshot.actionError}
            </p>
          )}

          <div className="state-strip" aria-label="Task and Agent Session states">
            <StateValue
              label="Task phase"
              phase={selected.task.phase as TaskPhaseToken}
              value={selected.task.phase}
              tone="task"
            />
            <StateValue
              label="Dependencies"
              {...(selected.blocked ? { phase: 'BLOCKED' as TaskPhaseToken } : {})}
              value={
                selected.blocked ? 'BLOCKED' : selected.dependencies.length === 0 ? 'NONE' : 'READY'
              }
              tone="task"
            />
            <StateValue
              label="Active session"
              {...(selected.activeSession?.status === undefined
                ? {}
                : { phase: selected.activeSession.status as TaskPhaseToken })}
              value={selected.activeSession?.status ?? 'NONE'}
              tone="session"
            />
            <StateValue
              label="Latest session"
              {...(selected.latestSession?.status === undefined
                ? {}
                : { phase: selected.latestSession.status as TaskPhaseToken })}
              value={selected.latestSession?.status ?? 'NONE'}
              tone="session"
            />
            <div className="session-identity">
              <span>Agent / Session</span>
              <strong>
                {selected.latestSession === undefined
                  ? 'No session history'
                  : `${formatAgentIdentity(snapshot.overview, selected.latestSession.agentId)} · ${selected.latestSession.id}`}
              </strong>
            </div>
            {selected.previousSession === undefined ? null : (
              <div className="previous-session">
                <span>Previous session</span>
                <strong>
                  {selected.previousSession.status} ·{' '}
                  {formatAgentIdentity(snapshot.overview, selected.previousSession.agentId)} ·{' '}
                  {selected.previousSession.id}
                </strong>
              </div>
            )}
            {selected.latestSession?.failureCode === 'RUNTIME_OWNERSHIP_LOST' ? (
              <p className="restore-state" role="status">
                The previous Agent Session was interrupted when AgentTerm restarted. Task phase
                remains {selected.task.phase}.
              </p>
            ) : null}
          </div>
          <section className="task-brief" aria-label="Task brief">
            <p className="eyebrow">Task brief</p>
            <p>{selected.task.brief ?? 'This legacy Task has no persisted brief.'}</p>
          </section>
          <TaskDependencies blocked={selected.blocked} dependencies={selected.dependencies} />
          <DependencyEditor
            candidates={selectedProject.tasks.map((entry) => entry.task)}
            currentTask={selected.task}
            dependencies={selected.dependencies.map((entry) => ({
              id: entry.id,
              phase: entry.phase,
              title: entry.title,
            }))}
            disabled={snapshot.activeAction !== undefined}
            onAdd={(input) => void controller?.addTaskDependency(input)}
            onRemove={(input) => void controller?.removeTaskDependency(input)}
          />
          <PullRequestPanel
            actionsBusy={actionsBusy}
            inspection={snapshot.pullRequestInspection}
            onCreate={onCreatePullRequest}
            onPush={onPushTaskBranch}
            onRefresh={onRefreshPullRequest}
            taskId={selected.task.id}
            activeAction={snapshot.activeAction}
          />
          <PlanningSummary plan={selected.latestPlan} />
          <ChangeInspector
            inspection={snapshot.changeInspection}
            onSelectChange={onSelectTaskChange}
          />
          <ReviewHistory reviews={selected.reviewHistory} />
          <ArtifactProducer
            activeSessionId={selected.activeSession?.id}
            disabled={snapshot.activeAction !== undefined}
            onProduce={(input) => {
              onProduceArtifact({
                content: input.content,
                createdAt: input.createdAt,
                id: input.id,
                sessionId: input.sessionId,
                taskId: input.taskId,
              });
              return Promise.resolve({
                canonicalName: 'planning/plan.md',
                content: input.content,
                createdAt: input.createdAt,
                format: 'markdown',
                id: input.id,
                kind: input.kind,
                phase: selected.task.phase,
                schemaVersion: 1,
                sessionId: input.sessionId,
                taskId: input.taskId,
                validation: 'VALID',
              } as never);
            }}
            overview={selected}
            task={selected.task}
          />
          <ArtifactHistory artifacts={selected.artifacts} />
          <QualityGateHistory runs={selected.qualityGateRuns} />
          <ResizableTerminalWorkspace
            initialHeight={layout.terminalHeight}
            onHeightChange={(height) =>
              setLayout((current) => ({ ...current, terminalHeight: height }))
            }
          >
            <WorkspaceTerminals
              {...(client === undefined ? {} : { client })}
              layout={snapshot.layout}
              fontSize={snapshot.settings?.settings.terminalFontSize ?? 14}
              onActivatePane={onSelectWorkspacePane}
              onActivateTab={onSelectWorkspaceTab}
              onClosePane={onCloseWorkspacePane}
              onCloseTab={onCloseWorkspaceTab}
              onRuntimeEvent={(event) => {
                if (event.kind !== 'output') onRefresh();
              }}
              onSplit={onSplitTerminal}
              overview={snapshot.overview}
            />
          </ResizableTerminalWorkspace>
          <WorkspaceFooterStatus
            agentName={
              selected.activeSession === undefined
                ? undefined
                : formatAgentIdentity(snapshot.overview, selected.activeSession.agentId)
            }
            gitBranch={undefined}
            oscillator={
              selected.activeSession !== undefined && selected.activeSession.status === 'WORKING'
            }
            pullRequestNumber={undefined}
            shortcutHints={[
              { key: 'Ctrl+Shift+P', label: 'Commands' },
              { key: 'Alt+1', label: 'Sidebar' },
              { key: 'Alt+3', label: 'Terminal' },
              { key: 'Alt+P', label: 'Plan' },
              { key: 'Alt+R', label: 'Retry' },
            ]}
            terminalState={terminalStateFor(selected.activeSession?.status)}
          />
          <WorkspaceCommandPalette
            commands={commands}
            onAction={handlePaletteAction}
            onRun={runPaletteCommand}
            recents={commandRecents}
            state={paletteState}
          />
        </section>
      )}
      <ToastStack
        onDismiss={(id) => {
          toastRegistryRef.current.dismiss(id);
          setToasts(toastRegistryRef.current.getToasts());
        }}
        toasts={toasts}
      />
    </main>
  );
}

interface TerminalResizeDrag {
  readonly height: number;
  readonly pointerId: number;
  readonly pointerY: number;
}
function ResizableTerminalWorkspace({
  children,
  initialHeight,
  onHeightChange,
}: {
  readonly children: React.ReactNode;
  readonly initialHeight?: number;
  readonly onHeightChange?: (height: number) => void;
}) {
  const [height, setHeight] = useState(initialHeight ?? DEFAULT_TERMINAL_HEIGHT);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<TerminalResizeDrag | undefined>(undefined);
  const animationFrame = useRef<number | undefined>(undefined);
  const viewportHeight =
    typeof window === 'undefined'
      ? DEFAULT_TERMINAL_HEIGHT + MAX_TERMINAL_VIEWPORT_OFFSET
      : window.innerHeight;
  useEffect(
    () => () => {
      if (animationFrame.current !== undefined) window.cancelAnimationFrame(animationFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (initialHeight !== undefined && initialHeight !== height) {
      setHeight(initialHeight);
    }
    // We intentionally react only when the persisted layout changes the initial height.
  }, [initialHeight]);
  const resizeBy = (delta: number) =>
    setHeight((current) => {
      const next = resizeTerminalHeight(current + delta, 0, 0, window.innerHeight);
      onHeightChange?.(next);
      return next;
    });
  return (
    <section
      className={`resizable-terminal${resizing ? ' resizable-terminal--resizing' : ''}`}
      style={{ '--terminal-height': `${String(height)}px` } as React.CSSProperties}
    >
      <div
        aria-label="Resize terminal height"
        aria-orientation="horizontal"
        aria-valuemax={Math.max(MIN_TERMINAL_HEIGHT, viewportHeight - MAX_TERMINAL_VIEWPORT_OFFSET)}
        aria-valuemin={MIN_TERMINAL_HEIGHT}
        aria-valuenow={height}
        className="terminal-resize-handle"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          resizeBy(event.key === 'ArrowUp' ? 24 : -24);
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
          setResizing(false);
        }}
        onPointerDown={(event) => {
          drag.current = { height, pointerId: event.pointerId, pointerY: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (active === undefined || active.pointerId !== event.pointerId) return;
          const currentY = event.clientY;
          if (animationFrame.current !== undefined)
            window.cancelAnimationFrame(animationFrame.current);
          animationFrame.current = window.requestAnimationFrame(() => {
            setHeight(
              resizeTerminalHeight(active.height, active.pointerY, currentY, window.innerHeight),
            );
            animationFrame.current = undefined;
          });
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = undefined;
          setResizing(false);
        }}
        role="separator"
        tabIndex={0}
      >
        <span aria-hidden="true" />
      </div>
      {children}
    </section>
  );
}

function PullRequestPanel({
  actionsBusy,
  activeAction,
  inspection,
  onCreate,
  onPush,
  onRefresh,
  taskId,
}: {
  readonly actionsBusy: boolean;
  readonly activeAction: Extract<WorkspaceSnapshot, { readonly kind: 'ready' }>['activeAction'];
  readonly inspection: Extract<
    WorkspaceSnapshot,
    { readonly kind: 'ready' }
  >['pullRequestInspection'];
  readonly onCreate: () => void;
  readonly onPush: () => void;
  readonly onRefresh: () => void;
  readonly taskId: string;
}) {
  return (
    <section className="pull-request-panel" aria-labelledby="pull-request-heading">
      <header>
        <div>
          <p className="eyebrow">Remote handoff</p>
          <h3 id="pull-request-heading">GitHub Pull Request</h3>
        </div>
      </header>
      {inspection === undefined || inspection.kind === 'idle' || inspection.kind === 'loading' ? (
        <p className="pull-request-panel__message" role="status">
          Inspecting Task branch readiness...
        </p>
      ) : inspection.kind === 'error' ? (
        <p className="inline-error" role="alert">
          {inspection.message}
        </p>
      ) : inspection.result.branch.kind === 'blocked' ? (
        <div>
          <p className="pull-request-panel__message">
            Not ready: {formatPullRequestBlock(inspection.result.branch.reason)}
          </p>
          {inspection.result.pullRequest === undefined ? null : (
            <>
              <p className="pull-request-panel__message">
                Last recorded PR #{inspection.result.pullRequest.number} ·{' '}
                {inspection.result.pullRequest.status} · {inspection.result.pullRequest.url}
              </p>
              <button
                className="secondary-action"
                disabled={actionsBusy}
                onClick={onRefresh}
                type="button"
              >
                {activeAction?.kind === 'refresh-pull-request' && activeAction.taskId === taskId
                  ? 'Refreshing GitHub status...'
                  : 'Refresh GitHub status'}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="pull-request-panel__body">
          <dl>
            <div>
              <dt>Repository</dt>
              <dd>
                {inspection.result.branch.repositoryOwner}/{inspection.result.branch.repositoryName}
              </dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>
                {inspection.result.branch.headBranch} → {inspection.result.branch.baseBranch}
              </dd>
            </div>
            <div>
              <dt>Remote</dt>
              <dd>
                {inspection.result.branch.remoteHeadCommitId ===
                inspection.result.branch.headCommitId
                  ? 'UP TO DATE'
                  : 'PUSH REQUIRED'}
              </dd>
            </div>
            <div>
              <dt>Pull Request</dt>
              <dd>
                {inspection.result.pullRequest === undefined
                  ? 'NONE'
                  : `#${String(inspection.result.pullRequest.number)} · ${inspection.result.pullRequest.status}`}
              </dd>
            </div>
            {inspection.result.pullRequest === undefined ? null : (
              <>
                <div>
                  <dt>Review state</dt>
                  <dd>{inspection.result.pullRequest.reviewState}</dd>
                </div>
                <div>
                  <dt>Checks</dt>
                  <dd>
                    {inspection.result.pullRequest.checks.state} ·{' '}
                    {inspection.result.pullRequest.checks.successCount}/
                    {inspection.result.pullRequest.checks.totalCount} passing
                  </dd>
                </div>
                <div>
                  <dt>Last synced</dt>
                  <dd>{formatPullRequestSyncTime(inspection.result.pullRequest.lastSyncedAt)}</dd>
                </div>
              </>
            )}
          </dl>
          {inspection.result.pullRequest === undefined ? null : (
            <p className="pull-request-panel__url">{inspection.result.pullRequest.url}</p>
          )}
          {!inspection.result.branch.githubCliAvailable ? (
            <p className="pull-request-panel__warning">
              GitHub CLI is unavailable. Push remains explicit; creating or refreshing a Pull
              Request requires an authenticated gh CLI.
            </p>
          ) : !inspection.result.branch.githubAuthenticationAvailable ? (
            <p className="pull-request-panel__warning">
              GitHub CLI is installed but has no active authenticated account for github.com.
              Authenticate with gh outside AgentTerm, then refresh.
            </p>
          ) : null}
          <div className="pull-request-panel__actions">
            <button
              className="secondary-action"
              disabled={!inspection.result.canPush || actionsBusy}
              onClick={onPush}
              type="button"
            >
              {activeAction?.kind === 'push-branch' && activeAction.taskId === taskId
                ? 'Pushing branch...'
                : 'Push Task branch'}
            </button>
            <button
              className="primary-action"
              disabled={!inspection.result.canCreatePullRequest || actionsBusy}
              onClick={onCreate}
              type="button"
            >
              {activeAction?.kind === 'create-pull-request' && activeAction.taskId === taskId
                ? 'Updating Pull Request...'
                : 'Create Pull Request'}
            </button>
            <button
              className="secondary-action"
              disabled={inspection.result.pullRequest === undefined || actionsBusy}
              onClick={onRefresh}
              type="button"
            >
              {activeAction?.kind === 'refresh-pull-request' && activeAction.taskId === taskId
                ? 'Refreshing GitHub status...'
                : 'Refresh GitHub status'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function formatPullRequestSyncTime(value: number | undefined): string {
  if (value === undefined) return 'NOT YET SYNCED';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'UNKNOWN' : date.toISOString();
}

function formatPullRequestBlock(reason: PullRequestBranchReadinessFailure): string {
  switch (reason) {
    case 'BRANCH_MISMATCH':
      return 'the checked-out branch does not match the Task Worktree record.';
    case 'DETACHED_HEAD':
      return 'the Task Worktree has a detached HEAD.';
    case 'GITHUB_REMOTE_NOT_FOUND':
      return 'no supported github.com remote was detected.';
    case 'INVALID_BASE_BRANCH':
      return 'the persisted base branch is not valid for this code state.';
    case 'NO_COMMITS_AHEAD':
      return 'the Task branch has no commits ahead of its base.';
    case 'UNCOMMITTED_CHANGES':
      return 'commit the Task Worktree changes before pushing a PR branch.';
    case 'WORKTREE_NOT_READY':
      return 'the Task primary Worktree has not been provisioned or is unavailable.';
    case 'INSPECTION_FAILED':
      return 'branch readiness could not be verified safely.';
  }
}

function ChangeInspector({
  inspection,
  onSelectChange,
}: {
  readonly inspection: Extract<WorkspaceSnapshot, { readonly kind: 'ready' }>['changeInspection'];
  readonly onSelectChange: (change: TaskFileChange) => void;
}) {
  return (
    <section
      className="change-inspector"
      aria-labelledby="change-inspector-heading"
      id="workspace-changes"
      tabIndex={-1}
    >
      <header className="change-inspector__header">
        <div>
          <p className="eyebrow">Git evidence</p>
          <h3 id="change-inspector-heading">Changed files</h3>
        </div>
        {inspection?.kind === 'ready' ? <span>{inspection.result.totalFiles}</span> : null}
      </header>
      {inspection === undefined || inspection.kind === 'idle' || inspection.kind === 'loading' ? (
        <p className="change-inspector__empty" role="status">
          Loading Task Worktree changes...
        </p>
      ) : inspection.kind === 'error' ? (
        <p className="inline-error" role="alert">
          {inspection.message}
        </p>
      ) : inspection.result.files.length === 0 ? (
        <p className="change-inspector__empty">The Task Worktree is clean.</p>
      ) : (
        <div className="change-inspector__body">
          <div>
            <ul className="change-list" aria-label="Task Worktree changed files">
              {inspection.result.files.map((change) => (
                <li key={changeIdentity(change)}>
                  <button
                    aria-pressed={sameDisplayedChange(inspection.selectedFile, change)}
                    onClick={() => onSelectChange(change)}
                    type="button"
                  >
                    <span>{change.area}</span>
                    <strong>{change.kind}</strong>
                    <code>
                      {change.previousPath === undefined
                        ? change.path
                        : `${change.previousPath} -> ${change.path}`}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
            {inspection.result.truncated ? (
              <p className="change-inspector__note">
                Showing a bounded file list; {inspection.result.totalFiles} changes were found.
              </p>
            ) : null}
          </div>
          <div className="change-diff" aria-live="polite">
            {inspection.diffLoading ? (
              <p role="status">Loading selected diff...</p>
            ) : inspection.diffError !== undefined ? (
              <p className="inline-error" role="alert">
                {inspection.diffError}
              </p>
            ) : inspection.selectedDiff === undefined ? (
              <p>Select a changed file to load its bounded diff.</p>
            ) : (
              <FileDiff diff={inspection.selectedDiff} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function FileDiff({ diff }: { readonly diff: TaskFileDiff }) {
  return (
    <>
      <header className="change-diff__header">
        <strong>{diff.path}</strong>
        <span>
          {diff.additions === undefined ? '?' : `+${diff.additions}`} /{' '}
          {diff.deletions === undefined ? '?' : `-${diff.deletions}`}
        </span>
      </header>
      {diff.omittedReason === 'BINARY' ? (
        <p>Binary diff omitted.</p>
      ) : diff.omittedReason === 'TOO_LARGE' ? (
        <p>Diff omitted because it exceeds the safe display limit.</p>
      ) : diff.omittedReason === 'UNSUPPORTED' ? (
        <p>This file type cannot be previewed safely.</p>
      ) : diff.patch === undefined ? (
        <p>No textual patch is available.</p>
      ) : (
        <pre>{diff.patch.text}</pre>
      )}
    </>
  );
}

function changeIdentity(change: TaskFileChange): string {
  return `${change.area}:${change.previousPath ?? ''}:${change.path}`;
}

function sameDisplayedChange(
  selected: TaskFileChange | undefined,
  candidate: TaskFileChange,
): boolean {
  return selected === undefined ? false : changeIdentity(selected) === changeIdentity(candidate);
}

function ReviewHistory({ reviews }: { readonly reviews: WorkspaceTaskOverview['reviewHistory'] }) {
  return (
    <section
      className="review-history"
      aria-labelledby="review-history-heading"
      id="workspace-review"
      tabIndex={-1}
    >
      <header className="review-history__header">
        <div>
          <p className="eyebrow">User decision record</p>
          <h3 id="review-history-heading">Review evidence</h3>
        </div>
        <span>
          {reviews.length} {reviews.length === 1 ? 'attempt' : 'attempts'}
        </span>
      </header>
      {reviews.length === 0 ? (
        <p className="review-history__empty">No Review attempts for this Task yet.</p>
      ) : (
        <ol className="review-history__list">
          {reviews.map((review) => (
            <li className="review-attempt" key={review.id}>
              <header className="review-attempt__header">
                <div>
                  <strong>{review.status}</strong>
                  <span>{review.id}</span>
                </div>
                <span className="review-freshness">{review.freshness}</span>
              </header>
              {review.freshness === 'REVALIDATE_ON_APPROVAL' ? (
                <p className="review-revalidation" role="status">
                  Approval revalidates this exact code snapshot before marking the Task done.
                </p>
              ) : null}
              <dl className="review-code-state">
                <div>
                  <dt>Fingerprint</dt>
                  <dd>{review.codeState.fingerprint}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{review.codeState.branchName}</dd>
                </div>
                <div>
                  <dt>Base / HEAD</dt>
                  <dd>
                    {review.codeState.baseCommitId} / {review.codeState.headCommitId}
                  </dd>
                </div>
              </dl>
              <div className="review-evidence-counts">
                <span>
                  {review.codeState.changes.total}{' '}
                  {review.codeState.changes.total === 1 ? 'changed path' : 'changed paths'}
                </span>
                <span>
                  {review.artifacts.length}{' '}
                  {review.artifacts.length === 1 ? 'artifact' : 'artifacts'}
                </span>
                <span>
                  {review.qualityGates.length}{' '}
                  {review.qualityGates.length === 1 ? 'quality gate' : 'quality gates'}
                </span>
              </div>
              <ReviewChangedPaths review={review} />
              {review.qualityGates.length === 0 ? null : (
                <ul className="review-gate-list" aria-label="Associated Quality Gate evidence">
                  {review.qualityGates.map((gate) => (
                    <li key={gate.id}>
                      <strong>{gate.kind}</strong>
                      <span>
                        {gate.gateId} / {gate.id}
                      </span>
                      <span>{gate.observedStatus}</span>
                      <span>{gate.association}</span>
                    </li>
                  ))}
                </ul>
              )}
              {review.decisionNote === undefined ? null : (
                <p className="review-decision-note">{review.decisionNote}</p>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ReviewChangedPaths({
  review,
}: {
  readonly review: WorkspaceTaskOverview['reviewHistory'][number];
}) {
  const entries = [
    ...review.codeState.changes.committed.map((path) => ({ kind: 'Committed', path })),
    ...review.codeState.changes.staged.map((path) => ({ kind: 'Staged', path })),
    ...review.codeState.changes.unstaged.map((path) => ({ kind: 'Unstaged', path })),
    ...review.codeState.changes.untracked.map((path) => ({ kind: 'Untracked', path })),
    ...review.codeState.changes.conflicted.map((path) => ({ kind: 'Conflicted', path })),
  ];

  if (entries.length === 0) {
    return review.codeState.changes.truncated ? (
      <p className="review-path-note">Changed paths are hidden or truncated.</p>
    ) : null;
  }

  return (
    <ul className="review-path-list" aria-label="Changed repository paths">
      {entries.map(({ kind, path }) => (
        <li key={`${kind}:${path}`}>
          <span>{kind}</span>
          <code>{path}</code>
        </li>
      ))}
      {review.codeState.changes.truncated ? <li>Additional paths hidden or truncated.</li> : null}
    </ul>
  );
}

function QualityGateHistory({ runs }: { readonly runs: WorkspaceTaskOverview['qualityGateRuns'] }) {
  const newestFirst = [...runs].reverse();

  return (
    <section
      className="quality-gates"
      aria-labelledby="quality-gates-heading"
      id="workspace-checks"
      tabIndex={-1}
    >
      <header className="quality-gates__header">
        <div>
          <p className="eyebrow">Recorded evidence</p>
          <h3 id="quality-gates-heading">Quality gates</h3>
        </div>
        <span>
          {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        </span>
      </header>
      {newestFirst.length === 0 ? (
        <p className="quality-gates__empty">
          No AgentTerm-recorded gate evidence for this Task yet.
        </p>
      ) : (
        <ol className="quality-gates__list">
          {newestFirst.map((run) => (
            <li className="quality-gate-run" key={run.id}>
              <div className="quality-gate-run__summary">
                <strong>{run.kind}</strong>
                <span className="quality-gate-run__identity">
                  {run.gateId} / {run.id}
                </span>
                <span className={`quality-gate-status quality-gate-status--${run.status}`}>
                  {run.status}
                </span>
                <span>{formatDuration(run.durationMs)}</span>
                <span>{run.exitCode === undefined ? 'No exit code' : `Exit ${run.exitCode}`}</span>
                {run.failureCategory === undefined ? null : <span>{run.failureCategory}</span>}
              </div>
              {run.output === undefined ? null : (
                <pre className="quality-gate-run__output">
                  {run.output.text}
                  {run.output.truncated ? '\n... output truncated' : ''}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ArtifactHistory({
  artifacts,
}: {
  readonly artifacts: WorkspaceTaskOverview['artifacts'];
}) {
  return (
    <section
      className="artifact-history"
      aria-label="Execution artifacts"
      id="workspace-artifacts"
      tabIndex={-1}
    >
      <header className="artifact-history__header">
        <div>
          <p className="eyebrow">Execution evidence</p>
          <h3>Execution artifacts</h3>
        </div>
        <span>{artifacts.length}</span>
      </header>
      {artifacts.length === 0 ? (
        <p className="artifact-history__empty">No structured artifacts for this Task yet.</p>
      ) : (
        <ol className="artifact-list">
          {artifacts.map((artifact) => (
            <li className="artifact-card" key={artifact.id}>
              <header>
                <div>
                  <strong>{artifact.kind}</strong>
                  <span>{artifact.canonicalName}</span>
                </div>
                <div className="artifact-card__provenance">
                  <span>{artifact.phase}</span>
                  <span>{artifact.sessionId ?? 'Task-level'}</span>
                </div>
              </header>
              <pre>{artifact.content}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TaskDependencies({
  blocked,
  dependencies,
}: {
  readonly blocked: boolean;
  readonly dependencies: WorkspaceTaskOverview['dependencies'];
}) {
  if (dependencies.length === 0) return null;
  return (
    <section className="task-dependencies" aria-labelledby="task-dependencies-heading">
      <header>
        <div>
          <p className="eyebrow">Execution readiness</p>
          <h3 id="task-dependencies-heading">Task dependencies</h3>
        </div>
        <span>{blocked ? 'Blocked' : 'Ready'}</span>
      </header>
      <ul>
        {dependencies.map((dependency) => (
          <li key={dependency.id}>
            <strong>{dependency.title}</strong>
            <span>
              {dependency.phase}
              {' \u00b7 '}
              {dependency.satisfied ? 'Complete' : 'Required'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return 'Result pending';
  }
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)} s`;
}
function WorkspaceSidebar({
  busy,
  error,
  onCreateTask,
  onOpenProject,
  onSelectTask,
  onToggleCollapsed,
  projects,
  qualityGateConfig,
  sidebarCollapsed,
  selectedTaskId,
  settingsPanel,
}: {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onCreateTask: (input: {
    readonly brief: string;
    readonly projectId: string;
    readonly title: string;
  }) => boolean | Promise<boolean>;
  readonly onOpenProject: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onToggleCollapsed?: () => void;
  readonly sidebarCollapsed: boolean;
  readonly projects: readonly WorkspaceProjectOverview[];
  readonly qualityGateConfig?: React.ReactNode;
  readonly selectedTaskId: string | undefined;
  readonly settingsPanel?: React.ReactNode;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.project.id ?? '');
  const [brief, setBrief] = useState('');
  const [title, setTitle] = useState('');
  useEffect(() => {
    if (!projects.some(({ project }) => project.id === projectId)) {
      setProjectId(projects[0]?.project.id ?? '');
    }
  }, [projectId, projects]);

  return (
    <aside className="workspace-sidebar" id="workspace-sidebar" tabIndex={-1}>
      <header className="workspace-brand">
        <span className="brand-mark" aria-hidden="true">
          AT
        </span>
        <div>
          <p className="eyebrow">Agent workspace</p>
          <h1>AgentTerm</h1>
        </div>
        <kbd>Alt+1</kbd>
        {onToggleCollapsed === undefined ? null : (
          <button
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-toggle"
            onClick={onToggleCollapsed}
            type="button"
          >
            {sidebarCollapsed ? '›' : '�'}
          </button>
        )}
      </header>
      <section className="workspace-onboarding" aria-label="Project and Task setup">
        <button className="secondary-action" disabled={busy} onClick={onOpenProject} type="button">
          {busy ? 'Working…' : 'Open Project'}
        </button>
        {projects.length === 0 ? null : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void Promise.resolve(onCreateTask({ brief, projectId, title })).then((created) => {
                if (created) {
                  setBrief('');
                  setTitle('');
                }
              });
            }}
          >
            <label>
              <span>Project</span>
              <select
                aria-label="Project for new Task"
                disabled={busy}
                onChange={(event) => setProjectId(event.currentTarget.value)}
                value={projectId}
              >
                {projects.map(({ project }) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Task title</span>
              <input
                disabled={busy}
                maxLength={512}
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="What should the agent work on?"
                required
                type="text"
                value={title}
              />
            </label>
            <label>
              <span>Task brief</span>
              <textarea
                disabled={busy}
                maxLength={16_384}
                onChange={(event) => setBrief(event.currentTarget.value)}
                placeholder="Describe the outcome, constraints, and evidence the agent should produce."
                required
                rows={5}
                value={brief}
              />
            </label>
            <button
              className="primary-action"
              disabled={busy || title.trim().length === 0 || brief.trim().length === 0}
              type="submit"
            >
              Create Task
            </button>
          </form>
        )}
        {error === undefined ? null : (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <nav className="project-navigation" aria-label="Projects and Tasks">
        {projects.map((project) => (
          <section className="project-group" key={project.project.id}>
            <header className="project-group__header">
              <h2>{project.project.name}</h2>
              <span>{project.tasks.length}</span>
            </header>
            {project.tasks.length === 0 ? (
              <EmptyState
                description="Create the first Task for this Project to start coordinating a coding Agent."
                icon="inbox"
                title="No Tasks yet"
              />
            ) : (
              <ul className="task-list">
                {project.tasks.map((task, index) => (
                  <li key={task.task.id}>
                    <button
                      aria-pressed={task.task.id === selectedTaskId}
                      className="task-option"
                      onClick={() => onSelectTask(task.task.id)}
                      type="button"
                    >
                      <span className="task-option__title">{task.task.title}</span>
                      <span className="task-option__states">
                        <span>{task.task.phase}</span>
                        <span>{task.latestSession?.status ?? 'NO SESSION'}</span>
                      </span>
                      <kbd className="task-option__hint" aria-hidden="true">
                        {index + 1}
                      </kbd>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </nav>
      {settingsPanel === undefined ? null : (
        <div className="workspace-sidebar__settings">{settingsPanel}</div>
      )}
      {qualityGateConfig === undefined ? null : (
        <div className="workspace-sidebar__quality-gates">{qualityGateConfig}</div>
      )}
    </aside>
  );
}

function StateValue({
  label,
  phase,
  tone,
  value,
}: {
  readonly label: string;
  readonly phase?: TaskPhaseToken;
  readonly tone: 'session' | 'task';
  readonly value: string;
}) {
  const phaseClassName = phase === undefined ? undefined : phaseTokenClass(phase);
  return (
    <div className={`state-value state-value--${tone}`}>
      <span>{label}</span>
      <strong className="state-value__inner">
        {phaseClassName === undefined ? null : (
          <span
            aria-hidden="true"
            className={`phase-dot ${phaseClassName}${
              phase === 'RUNNING' ? ' phase-running--active' : ''
            }`}
          />
        )}
        <span>{value}</span>
      </strong>
    </div>
  );
}

type TaskPhaseToken = 'BACKLOG' | 'BLOCKED' | 'DONE' | 'PLANNING' | 'REVIEW' | 'RUNNING';

function phaseTokenClass(phase: string): string | undefined {
  const normalized = phase.trim().toUpperCase().replace(/\s+/gu, '_');
  switch (normalized) {
    case 'BACKLOG':
      return 'phase-dot--backlog';
    case 'PLANNING':
      return 'phase-dot--planning';
    case 'RUNNING':
    case 'IN_PROGRESS':
    case 'EXECUTING':
      return 'phase-dot--running';
    case 'REVIEW':
    case 'IN_REVIEW':
    case 'AWAITING_REVIEW':
      return 'phase-dot--review';
    case 'DONE':
    case 'COMPLETED':
    case 'MERGED':
      return 'phase-dot--done';
    case 'BLOCKED':
    case 'FAILED':
    case 'CANCELLED':
      return 'phase-dot--blocked';
    default:
      return undefined;
  }
}

function WorkspaceMessage({
  children,
  eyebrow,
  message,
}: {
  readonly children?: React.ReactNode;
  readonly eyebrow: string;
  readonly message: string;
}) {
  return (
    <section className="workspace-message">
      <p className="eyebrow">{eyebrow}</p>
      <h1>AgentTerm</h1>
      <p>{message}</p>
      {children}
    </section>
  );
}

function canStartAttempt(
  task: WorkspaceTaskOverview,
  selectedAgentId: string | undefined,
): boolean {
  return (
    (task.canRetryExecution ||
      task.canStartExecution ||
      task.canStartPlanning ||
      task.canRevisePlan) &&
    selectedAgentId !== undefined
  );
}

function isAttemptActionForTask(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  taskId: string,
): boolean {
  return (
    isSelectedAction(snapshot, taskId, 'start-execution') ||
    isSelectedAction(snapshot, taskId, 'retry-execution') ||
    isSelectedAction(snapshot, taskId, 'start-planning')
  );
}

function isSelectedAction(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  taskId: string,
  kind: WorkspaceActionKind,
): boolean {
  return snapshot.activeAction?.taskId === taskId && snapshot.activeAction.kind === kind;
}

function startAttemptTitle(
  task: WorkspaceTaskOverview,
  selectedAgentId: string | undefined,
): string {
  if (task.blocked) {
    return 'Complete all required Task dependencies before starting another Agent Session.';
  }
  if (
    (task.canRetryExecution ||
      task.canStartExecution ||
      task.canStartPlanning ||
      task.canRevisePlan) &&
    selectedAgentId === undefined
  ) {
    return 'No configured coding agent is currently available.';
  }
  if (task.canRetryExecution) {
    if (isFirstExecutionAfterPlan(task)) {
      return 'Launch execution from the accepted Plan in the existing primary Task Worktree.';
    }
    return 'Reuse the primary Task Worktree and launch a new Agent Session attempt.';
  }
  if (task.canStartPlanning || task.canRevisePlan) {
    return 'Reuse the primary Task Worktree and launch a new planning Agent Session.';
  }
  return task.canStartExecution
    ? 'Provision or reuse the Task Worktree and launch a new Agent Session.'
    : task.activeSession === undefined
      ? 'The Task must be in PLANNING or RUNNING before execution can start.'
      : 'The Task already has an active Agent Session.';
}

function isFirstExecutionAfterPlan(task: WorkspaceTaskOverview): boolean {
  return (
    task.task.phase === 'RUNNING' &&
    task.latestPlan?.sessionId !== undefined &&
    task.latestPlan.sessionId === task.latestSession?.id
  );
}

function PlanningSummary({ plan }: { readonly plan: WorkspaceTaskOverview['latestPlan'] }) {
  if (plan === undefined) return null;
  return (
    <section className="planning-summary" aria-labelledby="planning-summary-heading">
      <header>
        <div>
          <p className="eyebrow">Latest immutable planning artifact</p>
          <h3 id="planning-summary-heading">Current plan</h3>
        </div>
        <span>{plan.id}</span>
      </header>
      <p className="artifact-card__provenance">
        Session {plan.sessionId ?? 'unattributed'} · {plan.validation}
      </p>
      <pre>{plan.content}</pre>
    </section>
  );
}

function formatAgentOption(agent: AgentWorkspaceOverview['agents'][number]): string {
  const identity = `${agent.displayName} (${agent.id})`;
  if (agent.kind === 'unavailable') {
    const reason =
      agent.reason === 'EXECUTABLE_NOT_FOUND' ? 'Executable not found' : 'Inspection failed';
    return `${identity} — Unavailable · ${reason}`;
  }
  const capabilities =
    agent.capabilities.length === 0
      ? 'No optional capabilities'
      : agent.capabilities
          .map((capability) => (capability === 'SESSION_RESUME' ? 'Session resume' : capability))
          .join(', ');
  return `${identity} — Available · ${capabilities}`;
}

function formatAgentIdentity(overview: AgentWorkspaceOverview, agentId: string): string {
  const configured = overview.agents.find((agent) => agent.id === agentId);
  return configured === undefined ? agentId : `${configured.displayName} (${configured.id})`;
}

function terminalStateFor(
  status: string | undefined,
): 'attaching' | 'connected' | 'empty' | 'exited' | 'failed' {
  if (status === undefined) {
    return 'empty';
  }
  switch (status) {
    case 'WORKING':
      return 'connected';
    case 'IDLE':
      return 'connected';
    case 'WAITING_INPUT':
      return 'connected';
    case 'ATTACHING':
      return 'attaching';
    case 'EXITED':
      return 'exited';
    case 'FAILED':
      return 'failed';
    default:
      return 'empty';
  }
}

function findTask(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  taskId: string | undefined,
): WorkspaceTaskOverview | undefined {
  return snapshot.overview.projects
    .flatMap((project) => project.tasks)
    .find((task) => task.task.id === taskId);
}

function findProject(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  projectId: string | undefined,
): WorkspaceProjectOverview | undefined {
  return snapshot.overview.projects.find((project) => project.project.id === projectId);
}

const focusTargetIds: Readonly<Record<WorkspaceFocusTarget, string>> = Object.freeze({
  artifacts: 'workspace-artifacts',
  changes: 'workspace-changes',
  checks: 'workspace-checks',
  review: 'workspace-review',
  sidebar: 'workspace-sidebar',
  terminal: '',
  workspace: 'workspace-main',
});

function focusWorkspaceTarget(target: WorkspaceFocusTarget): void {
  const element =
    target === 'terminal'
      ? document.querySelector<HTMLElement>('[data-active-terminal-pane="true"]')
      : document.getElementById(focusTargetIds[target]);
  element?.focus({ preventScroll: true });
  element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scheduleTerminalFocus(): void {
  requestAnimationFrame(() => focusWorkspaceTarget('terminal'));
}
