import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import type {
  AgentWorkspaceOverview,
  ExecutionArtifact,
  PullRequestBranchReadinessFailure,
  QualityGate,
  TaskFileChange,
  TaskFileDiff,
  UpdateApplicationSettingsInput,
  WorkspaceProjectOverview,
  WorkspaceTaskOverview,
} from '@agentterm/application';

import { WorkspaceCommandPalette } from './command-palette';
import { WorkspaceProjectBoard } from './workspace-project-board';
import { WorkspaceTerminals, type ActiveTerminalContext } from './workspace-terminals';
import { WorkspaceFooterStatus } from './workspace-footer-status';
import { WorkspaceSettingsGear } from './workspace-settings-gear';
import { WorkspaceIcon } from './workspace-icons';
import { SettingsPanel } from './settings-panel';
import { EmptyState } from './empty-state';
import { ContextCard } from './context-card';
import { ArtifactProducer } from './artifact-producer';
import { DependencyEditor } from './dependency-editor';
import { QualityGateConfiguration } from './quality-gate-config';
import {
  readPersistedLayout,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writePersistedLayout,
} from './workspace-layout-persistence';
import {
  DEFAULT_TERMINAL_HEIGHT,
  MAX_TERMINAL_VIEWPORT_OFFSET,
  MIN_TERMINAL_HEIGHT,
  maximumTerminalHeight,
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
import { resolveWorkspaceMnemonic } from './mnemonic-hints';
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
  readonly onAddDependency: (input: {
    readonly dependencyTaskId: string;
    readonly taskId: string;
  }) => void;
  readonly onProduceArtifact: (input: {
    readonly content: string;
    readonly createdAt: number;
    readonly id: string;
    readonly kind: ExecutionArtifact['kind'];
    readonly sessionId: string | undefined;
    readonly taskId: string;
  }) => Promise<ExecutionArtifact>;
  readonly onCloseWorkspacePane: (paneId: string) => void;
  readonly onCloseWorkspaceTab: (tabId: string) => void;
  readonly onCycleWorkspacePane: (delta: -1 | 1) => void;
  readonly onCycleWorkspaceTab: (delta: -1 | 1) => void;
  readonly onPushTaskBranch: () => void;
  readonly onOpenProject: () => void;
  readonly onRefreshPullRequest: () => void;
  readonly onRefresh: () => void;
  readonly onRegisterQualityGate: (input: {
    readonly arguments: readonly string[];
    readonly executablePath: string;
    readonly id: string;
    readonly kind: QualityGate['kind'];
    readonly timeoutMs: number;
  }) => Promise<QualityGate>;
  readonly onRequestChanges: () => void;
  readonly onRequestReview: () => void;
  readonly onRemoveDependency: (input: {
    readonly dependencyTaskId: string;
    readonly taskId: string;
  }) => void;
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
  readonly onUnregisterQualityGate: (gateId: string) => Promise<boolean>;
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
      onAddDependency={(input) => void controller?.addTaskDependency(input)}
      onApproveReview={() => void controller?.approveSelectedTaskReview()}
      onBeginPlanning={() => void controller?.beginSelectedTaskPlanning()}
      onCreatePullRequest={() => void controller?.createSelectedTaskPullRequest()}
      onCreateTask={(input) => controller?.createTask(input) ?? false}
      onProduceArtifact={(input) =>
        controller?.produceArtifact(input) ??
        Promise.reject(new Error('Workspace controller is not available.'))
      }
      onCloseWorkspacePane={(paneId) => controller?.closeWorkspacePane(paneId)}
      onCloseWorkspaceTab={(tabId) => controller?.closeWorkspaceTab(tabId)}
      onCycleWorkspacePane={(delta) => controller?.cycleWorkspacePane(delta)}
      onCycleWorkspaceTab={(delta) => controller?.cycleWorkspaceTab(delta)}
      onRefresh={() => void controller?.refresh()}
      onRegisterQualityGate={(input) =>
        controller?.registerQualityGate(input) ??
        Promise.reject(new Error('Workspace controller is not available.'))
      }
      onPushTaskBranch={() => void controller?.pushSelectedTaskBranch()}
      onOpenProject={() => void controller?.openProject()}
      onRefreshPullRequest={() => void controller?.refreshSelectedTaskPullRequest()}
      onRequestChanges={() => void controller?.requestSelectedTaskChanges()}
      onRequestReview={() => void controller?.requestSelectedTaskReview()}
      onRemoveDependency={(input) => void controller?.removeTaskDependency(input)}
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
      onUnregisterQualityGate={(gateId) =>
        controller?.unregisterQualityGate(gateId) ?? Promise.resolve(false)
      }
      snapshot={snapshot}
    />
  );
}

export function AgentWorkspaceView({
  client,
  onAcceptPlan,
  onAddDependency,
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
  onRegisterQualityGate,
  onPushTaskBranch,
  onOpenProject,
  onRefreshPullRequest,
  onRequestChanges,
  onRequestReview,
  onRemoveDependency,
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
  onUnregisterQualityGate,
  snapshot,
}: AgentWorkspaceViewProps) {
  const [paletteState, setPaletteState] = useState(initialCommandPaletteState);
  const [commandRecents, setCommandRecents] = useState<readonly string[]>([]);
  const [layout, setLayout] = useState(() => readPersistedLayout());
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [compactInspector, setCompactInspector] = useState(false);
  const [compactNavigatorOpen, setCompactNavigatorOpen] = useState(false);
  const [narrowViewport, setNarrowViewport] = useState(false);
  const [navigatedProjectId, setNavigatedProjectId] = useState<string | undefined>(undefined);
  const [activeTerminalContext, setActiveTerminalContext] = useState<ActiveTerminalContext>(() =>
    Object.freeze({ connectionState: 'empty' }),
  );
  const closeNewTaskDialog = useCallback(() => setNewTaskOpen(false), []);
  const sidebarDrag = useRef<{ pointerId: number; pointerX: number; width: number } | undefined>(
    undefined,
  );
  const sidebarResizeFrame = useRef<number | undefined>(undefined);
  const paletteReturnFocus = useRef<HTMLElement | null>(null);
  const inspectorReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(
    () => () => {
      if (sidebarResizeFrame.current !== undefined) {
        window.cancelAnimationFrame(sidebarResizeFrame.current);
      }
    },
    [],
  );

  useEffect(() => {
    writePersistedLayout(layout);
  }, [layout]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', layout.theme);
  }, [layout.theme]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1120px)');
    const update = (): void => {
      if (query.matches) {
        const inspector = document.querySelector('.task-inspector');
        if (
          document.activeElement instanceof Node &&
          inspector?.contains(document.activeElement) === true
        ) {
          setInspectorOpen(true);
        }
      } else {
        setInspectorOpen(false);
      }
      setCompactInspector(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = (): void => {
      setNarrowViewport(query.matches);
      if (query.matches) {
        const navigator = document.getElementById('workspace-sidebar');
        setCompactNavigatorOpen(
          document.activeElement instanceof Node &&
            navigator?.contains(document.activeElement) === true,
        );
      } else {
        setCompactNavigatorOpen(false);
      }
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const controllerSelected =
    snapshot.kind === 'ready' ? findTask(snapshot, snapshot.selectedTaskId) : undefined;
  const selectedProject =
    snapshot.kind === 'ready'
      ? (findProject(snapshot, navigatedProjectId) ??
        findProject(snapshot, controllerSelected?.task.projectId) ??
        snapshot.overview.projects[0])
      : undefined;
  const selected =
    controllerSelected?.task.projectId === selectedProject?.project.id
      ? controllerSelected
      : undefined;
  const actionsBusy = snapshot.kind === 'ready' && snapshot.activeAction !== undefined;
  const closeCompactNavigator = useCallback((taskId?: string): void => {
    setCompactNavigatorOpen(false);
    requestAnimationFrame(() => {
      const task =
        taskId === undefined
          ? undefined
          : document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"]`);
      (task ?? document.querySelector<HTMLElement>('[data-navigator-toggle]'))?.focus({
        preventScroll: true,
      });
    });
  }, []);
  const openCompactNavigator = useCallback((): void => {
    setCompactNavigatorOpen(true);
    requestAnimationFrame(() => {
      document.getElementById('workspace-sidebar')?.focus({ preventScroll: true });
    });
  }, []);
  const closeInspector = useCallback((): void => {
    setInspectorOpen(false);
    if (!compactInspector) return;
    requestAnimationFrame(() => {
      const returnTarget = inspectorReturnFocus.current;
      const selectedCard =
        selected === undefined
          ? undefined
          : document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(selected.task.id)}"]`);
      (returnTarget?.isConnected === true ? returnTarget : selectedCard)?.focus({
        preventScroll: true,
      });
    });
  }, [compactInspector, selected]);
  const openInspector = useCallback((): void => {
    inspectorReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInspectorOpen(true);
    if (!compactInspector) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.task-inspector__close')?.focus({
        preventScroll: true,
      });
    });
  }, [compactInspector]);
  const focusTarget = useCallback(
    (target: WorkspaceFocusTarget): void => {
      if (target === 'sidebar') {
        if (narrowViewport) {
          setCompactNavigatorOpen(true);
        } else if (layout.sidebarCollapsed) {
          setLayout((current) => ({ ...current, sidebarCollapsed: false }));
        }
        requestAnimationFrame(() => focusWorkspaceTarget(target));
        return;
      }
      if (compactInspector && ['artifacts', 'changes', 'checks', 'review'].includes(target)) {
        openInspector();
        requestAnimationFrame(() => focusWorkspaceTarget(target));
        return;
      }
      focusWorkspaceTarget(target);
    },
    [compactInspector, layout.sidebarCollapsed, narrowViewport, openInspector],
  );

  useEffect(() => {
    if ((!compactInspector || !inspectorOpen) && (!narrowViewport || !compactNavigatorOpen)) {
      return;
    }
    const handleDrawerKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || newTaskOpen || paletteState.open) {
        return;
      }
      if (narrowViewport && compactNavigatorOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCompactNavigator();
          return;
        }
        if (event.key === 'Tab') {
          const navigator = document.getElementById('workspace-sidebar');
          if (navigator !== null) trapFocusWithin(event, navigator);
        }
        return;
      }
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      const inspector = document.querySelector('.task-inspector');
      if (
        compactInspector &&
        inspectorOpen &&
        active instanceof Node &&
        inspector?.contains(active) === true
      ) {
        event.preventDefault();
        closeInspector();
        return;
      }
    };
    document.addEventListener('keydown', handleDrawerKeyDown);
    return () => document.removeEventListener('keydown', handleDrawerKeyDown);
  }, [
    closeCompactNavigator,
    closeInspector,
    compactInspector,
    compactNavigatorOpen,
    inspectorOpen,
    narrowViewport,
    newTaskOpen,
    paletteState.open,
  ]);

  useEffect(() => {
    if (snapshot.kind !== 'ready') return;
    const task = findTask(snapshot, snapshot.selectedTaskId);
    if (task !== undefined) setNavigatedProjectId(task.task.projectId);
  }, [snapshot.kind, snapshot.kind === 'ready' ? snapshot.selectedTaskId : undefined]);

  useEffect(() => {
    if (snapshot.kind !== 'ready' || newTaskOpen) return;

    const handleGlobalKeyDown = (event: KeyboardEvent): void => {
      const shortcut = resolveWorkspaceGlobalShortcut(event);
      if (shortcut === undefined) return;
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
      focusTarget(shortcut.replace('focus-', '') as WorkspaceFocusTarget);
    };
    const handleMnemonicKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || selected === undefined || actionsBusy) return;
      const action = resolveWorkspaceMnemonic(
        {
          altKey: event.altKey,
          composing: event.isComposing,
          ctrlKey: event.ctrlKey,
          editable: isEditableTarget(event.target),
          key: event.key,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        },
        selected,
      );
      if (action === undefined) return;
      event.preventDefault();
      switch (action) {
        case 'begin-planning':
          onBeginPlanning();
          return;
        case 'start-planning':
          onStartPlanning();
          return;
        case 'start-task':
          onStartTask();
          return;
        case 'retry-task':
          onRetryTask();
          return;
        case 'request-review':
          onRequestReview();
          return;
        case 'request-changes':
          onRequestChanges();
          return;
        case 'accept-plan':
          onAcceptPlan();
          return;
        case 'approve-review':
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
  }, [
    actionsBusy,
    onAcceptPlan,
    onApproveReview,
    onBeginPlanning,
    onCycleWorkspacePane,
    onCycleWorkspaceTab,
    onRequestChanges,
    onRequestReview,
    onRetryTask,
    onStartPlanning,
    onStartTask,
    focusTarget,
    newTaskOpen,
    selected,
    snapshot.kind,
  ]);

  if (snapshot.kind === 'loading') {
    return (
      <TransientWorkspaceShell layout={layout} loading>
        <WorkspaceMessage
          eyebrow="Workspace"
          role="status"
          message="Loading projects, tasks, and saved sessions…"
          title="Workspace loading"
        />
      </TransientWorkspaceShell>
    );
  }
  if (snapshot.kind === 'error') {
    return (
      <TransientWorkspaceShell layout={layout}>
        <WorkspaceMessage
          eyebrow="Workspace unavailable"
          message={snapshot.message}
          role="alert"
          title="AgentTerm could not open the workspace"
        >
          <button className="secondary-action" onClick={onRetry} type="button">
            Retry
          </button>
        </WorkspaceMessage>
      </TransientWorkspaceShell>
    );
  }
  const planningAttempt = selected?.canStartPlanning || selected?.canRevisePlan;
  const firstExecutionAfterPlan =
    selected === undefined ? false : isFirstExecutionAfterPlan(selected);
  const navigatorOpen = narrowViewport ? compactNavigatorOpen : !layout.sidebarCollapsed;
  const footerTask = findTask(snapshot, activeTerminalContext.taskId);
  const footerSession = findTaskSession(footerTask, activeTerminalContext.sessionId);
  const commands = buildWorkspaceCommands(
    {
      actionBusy: actionsBusy,
      now: Date.now(),
      qualityGates: snapshot.qualityGates ?? [],
      selectedAgentId: snapshot.selectedAgentId,
      selectedTask:
        selected === undefined
          ? undefined
          : {
              canProduceArtifact:
                selected.task.phase !== 'DONE',
              canRequestReview: selected.canRequestReview,
              canRetryExecution: selected.canRetryExecution,
              canRevisePlan: selected.canRevisePlan,
              canRunQualityGate: selected.canRunQualityGate,
              canStartExecution: selected.canStartExecution,
              canStartPlanning: selected.canStartPlanning,
              dependencies: selected.dependencies.map((dependency) => ({
                id: dependency.id,
                phase: dependency.phase as 'BACKLOG' | 'DONE' | 'PLANNING' | 'REVIEW' | 'RUNNING',
                projectId: selectedProject?.project.id ?? '',
                title: dependency.title,
              })),
              id: selected.task.id,
              projectId: selectedProject?.project.id ?? '',
              title: selected.task.title,
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
      addDependency: (dependencyTaskId, taskId) => {
        onAddDependency({ dependencyTaskId, taskId });
      },
      focus: focusTarget,
      produceArtifact: onProduceArtifact,
      registerQualityGate: onRegisterQualityGate,
      removeDependency: (dependencyTaskId, taskId) => {
        onRemoveDependency({ dependencyTaskId, taskId });
      },
      requestReview: onRequestReview,
      retryExecution: onRetryTask,
      runQualityGate: onRunQualityGate,
      selectTask: (taskId) => {
        onSelectTask(taskId);
        focusTarget('workspace');
      },
      startExecution: onStartTask,
      startPlanning: onStartPlanning,
      unregisterQualityGate: (gateId) => onUnregisterQualityGate(gateId),
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

  const focusNewTaskComposer = (): void => {
    setNewTaskOpen(true);
    requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('[data-new-task-title="true"]')?.focus();
    });
  };

  const workspaceRuntime = (
    <Fragment key="workspace-runtime">
      <section aria-label="Agent Console" className="workspace-console-dock">
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
            onActiveConnectionStateChange={setActiveTerminalContext}
            onClosePane={onCloseWorkspacePane}
            onCloseTab={onCloseWorkspaceTab}
            onRuntimeEvent={(event) => {
              if (event.kind !== 'output') onRefresh();
            }}
            onSplit={onSplitTerminal}
            overview={snapshot.overview}
          />
        </ResizableTerminalWorkspace>
      </section>
      <WorkspaceFooterStatus
        agentName={
          footerSession === undefined
            ? undefined
            : formatAgentIdentity(snapshot.overview, footerSession.agentId)
        }
        gitBranch={footerTask?.latestReview?.codeState.branchName}
        oscillator={footerSession?.status === 'WORKING'}
        pullRequestNumber={
          footerTask?.task.id === selected?.task.id &&
          snapshot.pullRequestInspection?.kind === 'ready'
            ? snapshot.pullRequestInspection.result.pullRequest?.number
            : undefined
        }
        shortcutHints={[
          { key: 'Ctrl+Shift+P', label: 'Commands' },
          { key: 'Alt+1', label: 'Sidebar' },
          { key: 'Alt+3', label: 'Terminal' },
          { key: 'Alt+P', label: 'Plan' },
          { key: 'Alt+R', label: 'Retry' },
        ]}
        terminalState={activeTerminalContext.connectionState}
      />
      <WorkspaceCommandPalette
        commands={commands}
        onAction={handlePaletteAction}
        onRun={runPaletteCommand}
        recents={commandRecents}
        state={paletteState}
      />
    </Fragment>
  );

  return (
    <div
      aria-label="AgentTerm application"
      className={`workspace-shell${navigatorOpen ? '' : ' workspace-shell--sidebar-collapsed'}`}
      data-sidebar-position={layout.sidebarPosition}
      style={{ '--sidebar-width': `${String(layout.sidebarWidth)}px` } as React.CSSProperties}
    >
      <a
        className="skip-link"
        href="#workspace-main"
        tabIndex={narrowViewport && navigatorOpen ? -1 : undefined}
      >
        Skip to Task workspace
      </a>
      <p aria-live="polite" className="sr-only" role="status">
        {snapshot.activeAction === undefined
          ? 'Workspace ready.'
          : `${snapshot.activeAction.kind.replaceAll('-', ' ')} in progress.`}
      </p>
      <WorkspaceTopbar
        backgroundInert={narrowViewport && navigatorOpen}
        layout={layout}
        newTaskDisabled={snapshot.overview.projects.length === 0}
        onNewTask={focusNewTaskComposer}
        onOpenPalette={openPalette}
        onRefresh={onRefresh}
        navigatorOpen={navigatorOpen}
        onToggleSidebar={() => {
          if (narrowViewport) {
            if (compactNavigatorOpen) {
              closeCompactNavigator();
            } else {
              openCompactNavigator();
            }
          } else {
            setLayout((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
          }
        }}
        {...(selectedProject?.project.name === undefined
          ? {}
          : { projectName: selectedProject.project.name })}
        settings={
          <WorkspaceSettingsGear layout={layout} onLayoutChange={setLayout}>
            {snapshot.settings === undefined || onSaveSettings === undefined ? null : (
              <SettingsPanel
                error={snapshot.settingsError}
                onSave={onSaveSettings}
                saving={snapshot.settingsSaving ?? false}
                view={snapshot.settings}
              />
            )}
            <QualityGateConfiguration
              busy={snapshot.activeAction !== undefined}
              error={undefined}
              gates={snapshot.qualityGates ?? []}
              onRegister={onRegisterQualityGate}
              onUnregister={onUnregisterQualityGate}
            />
          </WorkspaceSettingsGear>
        }
      />
      <WorkspaceSidebar
        busy={snapshot.onboardingBusy ?? false}
        hidden={!navigatorOpen}
        modal={narrowViewport && navigatorOpen}
        onOpenProject={onOpenProject}
        onSelectProject={(project) => {
          setNavigatedProjectId(project.project.id);
          const firstTaskId = project.tasks[0]?.task.id;
          if (firstTaskId !== undefined) onSelectTask(firstTaskId);
          if (narrowViewport) closeCompactNavigator(firstTaskId);
        }}
        projects={snapshot.overview.projects}
        selectedProjectId={selectedProject?.project.id}
      />
      {narrowViewport && navigatorOpen ? (
        <button
          aria-label="Close Project navigator"
          className="workspace-sidebar-backdrop"
          onClick={() => closeCompactNavigator()}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <div
        aria-label="Resize Project sidebar"
        aria-orientation="vertical"
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuenow={layout.sidebarWidth}
        className="sidebar-resize-handle"
        hidden={!navigatorOpen || narrowViewport}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const direction = layout.sidebarPosition === 'left' ? 1 : -1;
          setLayout((current) => ({
            ...current,
            sidebarWidth: Math.min(
              SIDEBAR_MAX_WIDTH,
              Math.max(
                SIDEBAR_MIN_WIDTH,
                current.sidebarWidth + (event.key === 'ArrowRight' ? 24 : -24) * direction,
              ),
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
          const direction = layout.sidebarPosition === 'left' ? 1 : -1;
          const nextWidth = Math.min(
            SIDEBAR_MAX_WIDTH,
            Math.max(
              SIDEBAR_MIN_WIDTH,
              active.width + (event.clientX - active.pointerX) * direction,
            ),
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
        <section
          {...(narrowViewport && navigatorOpen ? { inert: true } : {})}
          aria-label="Project workspace"
          className="workspace-main workspace-main--without-inspector"
          id="workspace-main"
          tabIndex={-1}
        >
          <WorkspaceMessage
            eyebrow={
              snapshot.overview.projects.length === 0
                ? 'Empty workspace'
                : selectedProject?.tasks.length === 0
                  ? 'Empty Project'
                  : 'No Task selected'
            }
            message={
              snapshot.overview.projects.length === 0
                ? 'No Projects yet. Open a local Git Project to begin.'
                : selectedProject?.tasks.length === 0
                  ? 'This Project has no Tasks yet. Create one to start planning and execution.'
                  : 'Choose a Task from this Project to open its board.'
            }
            title={
              snapshot.overview.projects.length === 0
                ? 'Start a workspace'
                : selectedProject?.tasks.length === 0
                  ? `${selectedProject.project.name} is ready`
                  : 'Select a Task'
            }
          >
            {snapshot.actionError === undefined || newTaskOpen ? null : (
              <p className="inline-error" role="alert">
                {snapshot.actionError}
              </p>
            )}
            {snapshot.overview.projects.length === 0 ? (
              <button
                className="primary-action"
                disabled={snapshot.onboardingBusy ?? false}
                onClick={onOpenProject}
                type="button"
              >
                Open Project
              </button>
            ) : selectedProject?.tasks.length === 0 ? (
              <button className="primary-action" onClick={focusNewTaskComposer} type="button">
                <WorkspaceIcon name="plus" size={16} />
                New Task
              </button>
            ) : null}
          </WorkspaceMessage>
          {workspaceRuntime}
        </section>
      ) : (
        <section
          {...(narrowViewport && navigatorOpen ? { inert: true } : {})}
          className="workspace-main"
          aria-label="Project workspace"
          id="workspace-main"
          tabIndex={-1}
        >
          <section className="workspace-board-pane">
            <header className="project-board-header">
              <div>
                <p className="eyebrow">{selectedProject.project.name}</p>
                <h1>Project Board</h1>
              </div>
              <div className="project-board-header__summary" aria-label="Project summary">
                <span>
                  {selectedProject.tasks.length}{' '}
                  {selectedProject.tasks.length === 1 ? 'Task' : 'Tasks'}
                </span>
                <span>
                  {
                    selectedProject.tasks.filter((entry) => entry.activeSession !== undefined)
                      .length
                  }{' '}
                  active Sessions
                </span>
                <button
                  aria-expanded={inspectorOpen}
                  className="project-board-header__inspector-toggle secondary-action"
                  onClick={openInspector}
                  type="button"
                >
                  <WorkspaceIcon name="info" size={16} />
                  Task details
                </button>
              </div>
            </header>
            {snapshot.actionError === undefined || newTaskOpen ? null : (
              <p className="inline-error workspace-action-error" role="alert">
                {snapshot.actionError}
              </p>
            )}
            <WorkspaceProjectBoard
              onSelectTask={(taskId) => {
                onSelectTask(taskId);
                openInspector();
              }}
              project={selectedProject}
              selectedTaskId={selected.task.id}
            />
          </section>
          <aside
            {...(compactInspector && !inspectorOpen ? { 'aria-hidden': true, inert: true } : {})}
            aria-label="Task inspector"
            className="task-inspector"
            data-open={inspectorOpen ? 'true' : 'false'}
          >
            <header className="task-inspector__bar">
              <div>
                <WorkspaceIcon name="info" size={16} />
                <strong>Task Inspector</strong>
              </div>
              <div className="task-inspector__bar-actions">
                <span>{selected.task.phase}</span>
                <button
                  aria-label="Close Task inspector"
                  className="task-inspector__close"
                  onClick={closeInspector}
                  type="button"
                >
                  <WorkspaceIcon name="close" size={16} />
                </button>
              </div>
            </header>
            <div className="task-inspector__scroll">
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
                        <option
                          disabled={agent.kind === 'unavailable'}
                          key={agent.id}
                          value={agent.id}
                        >
                          {formatAgentOption(agent)}
                        </option>
                      ))}
                    </select>
                  </label>
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
                      onClick={onApproveReview}
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
                </div>
              </header>

              <InspectorDisclosure defaultOpen title="Overview">
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
                      selected.blocked
                        ? 'BLOCKED'
                        : selected.dependencies.length === 0
                          ? 'NONE'
                          : 'READY'
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
                      The previous Agent Session was interrupted when AgentTerm restarted. Task
                      phase remains {selected.task.phase}.
                    </p>
                  ) : null}
                </div>
                <section className="task-brief" aria-label="Task brief">
                  <p className="eyebrow">Task brief</p>
                  <p>{selected.task.brief ?? 'This legacy Task has no persisted brief.'}</p>
                </section>
                <TaskWorkflow
                  blocked={selected.blocked}
                  phase={selected.task.phase as TaskPhaseToken}
                />
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
                  onAdd={onAddDependency}
                  onRemove={onRemoveDependency}
                />
              </InspectorDisclosure>
              <InspectorDisclosure
                defaultOpen={selected.task.phase === 'PLANNING'}
                title="Plan and Pull Request"
              >
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
              </InspectorDisclosure>
              <InspectorDisclosure title="Changes">
                <ChangeInspector
                  inspection={snapshot.changeInspection}
                  onSelectChange={onSelectTaskChange}
                />
              </InspectorDisclosure>
              <InspectorDisclosure
                badge={String(
                  selected.reviewHistory.length +
                    selected.artifacts.length +
                    selected.qualityGateRuns.length,
                )}
                defaultOpen={selected.task.phase === 'REVIEW'}
                title="Review and evidence"
              >
                <ReviewHistory reviews={selected.reviewHistory} />
                <ArtifactProducer
                  activeSessionId={selected.activeSession?.id}
                  disabled={snapshot.activeAction !== undefined}
                  onProduce={(input) =>
                    onProduceArtifact({
                      content: input.content,
                      createdAt: input.createdAt,
                      id: input.id,
                      kind: input.kind,
                      sessionId: input.sessionId,
                      taskId: input.taskId,
                    })
                  }
                  overview={selected}
                  task={selected.task}
                />
                <ArtifactHistory artifacts={selected.artifacts} />
                <QualityGateHistory runs={selected.qualityGateRuns} />
              </InspectorDisclosure>
            </div>
          </aside>
          {workspaceRuntime}
        </section>
      )}
      <NewTaskDialog
        busy={snapshot.onboardingBusy ?? false}
        error={snapshot.actionError}
        onClose={closeNewTaskDialog}
        onCreateTask={async (input) => {
          const created = await onCreateTask(input);
          if (created) setNewTaskOpen(false);
          return created;
        }}
        open={newTaskOpen}
        projects={snapshot.overview.projects}
        selectedProjectId={selectedProject?.project.id}
      />
    </div>
  );
}

function InspectorDisclosure({
  badge,
  children,
  defaultOpen = false,
  title,
}: {
  readonly badge?: string;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
  readonly title: string;
}) {
  return (
    <details className="inspector-disclosure" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {badge === undefined ? null : <span className="inspector-disclosure__badge">{badge}</span>}
        <WorkspaceIcon className="inspector-disclosure__chevron" name="chevron-right" size={15} />
      </summary>
      <div className="inspector-disclosure__content">{children}</div>
    </details>
  );
}

function WorkspaceTopbar({
  backgroundInert = false,
  layout,
  navigatorOpen,
  newTaskDisabled = false,
  onNewTask,
  onOpenPalette,
  onRefresh,
  onToggleSidebar,
  projectName,
  settings,
}: {
  readonly backgroundInert?: boolean;
  readonly layout: ReturnType<typeof readPersistedLayout>;
  readonly navigatorOpen?: boolean;
  readonly newTaskDisabled?: boolean;
  readonly onNewTask?: () => void;
  readonly onOpenPalette?: () => void;
  readonly onRefresh?: () => void;
  readonly onToggleSidebar?: () => void;
  readonly projectName?: string;
  readonly settings?: React.ReactNode;
}) {
  return (
    <header
      {...(backgroundInert ? { inert: true } : {})}
      aria-label="AgentTerm application"
      className="workspace-topbar"
    >
      <div className="workspace-topbar__identity">
        <span className="workspace-topbar__mark">
          <WorkspaceIcon name="brand" size={20} />
        </span>
        <strong>AgentTerm</strong>
        <span aria-hidden="true" className="workspace-topbar__divider" />
        <span className="workspace-topbar__project" title={projectName}>
          {projectName ?? 'Desktop workspace'}
        </span>
      </div>
      <button
        aria-label="Open command palette"
        className="workspace-topbar__search"
        disabled={onOpenPalette === undefined}
        onClick={onOpenPalette}
        type="button"
      >
        <WorkspaceIcon name="search" size={16} />
        <span>Search commands and Tasks</span>
        <kbd>Ctrl+Shift+P</kbd>
      </button>
      <div className="workspace-topbar__actions">
        <button
          aria-controls="workspace-sidebar"
          aria-expanded={navigatorOpen ?? !layout.sidebarCollapsed}
          aria-label={
            (navigatorOpen ?? !layout.sidebarCollapsed)
              ? 'Close Project navigator'
              : 'Open Project navigator'
          }
          className="workspace-topbar__icon-button workspace-topbar__sidebar-toggle"
          data-navigator-toggle
          disabled={onToggleSidebar === undefined}
          onClick={onToggleSidebar}
          type="button"
        >
          <WorkspaceIcon
            name={
              (navigatorOpen ?? !layout.sidebarCollapsed) === (layout.sidebarPosition === 'left')
                ? 'chevron-left'
                : 'chevron-right'
            }
            size={17}
          />
        </button>
        <button
          className="primary-action workspace-topbar__new-task"
          data-new-task-trigger
          disabled={onNewTask === undefined || newTaskDisabled}
          onClick={onNewTask}
          type="button"
        >
          <WorkspaceIcon name="plus" size={16} />
          New Task
        </button>
        <button
          aria-label="Refresh workspace"
          className="workspace-topbar__icon-button"
          disabled={onRefresh === undefined}
          onClick={onRefresh}
          type="button"
        >
          <WorkspaceIcon name="refresh" size={17} />
        </button>
        {settings}
      </div>
    </header>
  );
}

function TransientWorkspaceShell({
  children,
  layout,
  loading = false,
}: {
  readonly children: React.ReactNode;
  readonly layout: ReturnType<typeof readPersistedLayout>;
  readonly loading?: boolean;
}) {
  return (
    <div
      aria-label="AgentTerm application"
      className="workspace-shell workspace-shell--transient"
      data-sidebar-position={layout.sidebarPosition}
      style={{ '--sidebar-width': `${String(layout.sidebarWidth)}px` } as React.CSSProperties}
    >
      <a className="skip-link" href="#workspace-main">
        Skip to workspace status
      </a>
      <WorkspaceTopbar layout={layout} />
      <aside aria-label="Project navigator" className="workspace-sidebar workspace-sidebar--status">
        <header className="workspace-sidebar__header">
          <div>
            <p className="eyebrow">Navigator</p>
            <h2>Projects</h2>
          </div>
        </header>
        <div aria-hidden="true" className="workspace-sidebar__skeletons">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      </aside>
      <section
        aria-busy={loading}
        aria-label="Project workspace"
        className="workspace-main workspace-main--status"
        id="workspace-main"
        tabIndex={-1}
      >
        {children}
      </section>
    </div>
  );
}

function NewTaskDialog({
  busy,
  error,
  onClose,
  onCreateTask,
  open,
  projects,
  selectedProjectId,
}: {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onCreateTask: (input: {
    readonly brief: string;
    readonly projectId: string;
    readonly title: string;
  }) => boolean | Promise<boolean>;
  readonly open: boolean;
  readonly projects: readonly WorkspaceProjectOverview[];
  readonly selectedProjectId: string | undefined;
}) {
  const [brief, setBrief] = useState('');
  const [projectId, setProjectId] = useState(selectedProjectId ?? projects[0]?.project.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState('');
  const dialogRef = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const submittingRef = useRef(submitting);
  const wasOpen = useRef(false);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        if (!submittingRef.current) onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLInputElement>('[data-new-task-title="true"]')?.focus();
    });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      queueMicrotask(() => returnFocus.current?.focus({ preventScroll: true }));
    };
  }, [onClose, open]);

  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!open) return;
    if (opening || !projects.some(({ project }) => project.id === projectId)) {
      setProjectId(selectedProjectId ?? projects[0]?.project.id ?? '');
    }
  }, [open, projectId, projects, selectedProjectId]);

  if (!open) return null;

  const close = (): void => {
    if (!submitting) onClose();
  };

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        aria-labelledby="new-task-title"
        aria-modal="true"
        className="new-task-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="new-task-dialog__header">
          <div>
            <p className="eyebrow">Task onboarding</p>
            <h2 id="new-task-title">Create a new Task</h2>
          </div>
          <button aria-label="Close new Task dialog" onClick={close} type="button">
            <WorkspaceIcon name="close" size={17} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitting(true);
            void Promise.resolve(onCreateTask({ brief, projectId, title }))
              .then((created) => {
                if (created) {
                  setBrief('');
                  setTitle('');
                }
              })
              .finally(() => setSubmitting(false));
          }}
        >
          <label>
            <span>Project</span>
            <select
              aria-label="Project for new Task"
              disabled={busy || submitting}
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
              data-new-task-title="true"
              disabled={busy || submitting}
              maxLength={512}
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="What outcome should the agent deliver?"
              required
              type="text"
              value={title}
            />
          </label>
          <label>
            <span>Task brief</span>
            <textarea
              disabled={busy || submitting}
              maxLength={16_384}
              onChange={(event) => setBrief(event.currentTarget.value)}
              placeholder="Describe the outcome, constraints, and evidence required."
              required
              rows={7}
              value={brief}
            />
          </label>
          {error === undefined ? null : (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <footer className="new-task-dialog__actions">
            <button
              className="secondary-action"
              disabled={submitting}
              onClick={close}
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-action"
              disabled={
                busy ||
                submitting ||
                projectId.length === 0 ||
                title.trim().length === 0 ||
                brief.trim().length === 0
              }
              type="submit"
            >
              {submitting ? 'Creating…' : 'Create Task'}
            </button>
          </footer>
        </form>
      </section>
    </div>
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
  const [height, setHeight] = useState(() =>
    resizeTerminalHeight(
      initialHeight ?? DEFAULT_TERMINAL_HEIGHT,
      0,
      0,
      typeof window === 'undefined'
        ? DEFAULT_TERMINAL_HEIGHT + MAX_TERMINAL_VIEWPORT_OFFSET
        : window.innerHeight,
      typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
    ),
  );
  const [resizing, setResizing] = useState(false);
  const drag = useRef<TerminalResizeDrag | undefined>(undefined);
  const animationFrame = useRef<number | undefined>(undefined);
  const heightChangeRef = useRef(onHeightChange);
  const viewportHeight =
    typeof window === 'undefined'
      ? DEFAULT_TERMINAL_HEIGHT + MAX_TERMINAL_VIEWPORT_OFFSET
      : window.innerHeight;
  const viewportWidth =
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth;
  useEffect(
    () => () => {
      if (animationFrame.current !== undefined) window.cancelAnimationFrame(animationFrame.current);
    },
    [],
  );
  useEffect(() => {
    heightChangeRef.current = onHeightChange;
  }, [onHeightChange]);
  useEffect(() => {
    const clampToViewport = (): void => {
      setHeight((current) => {
        const next = resizeTerminalHeight(current, 0, 0, window.innerHeight, window.innerWidth);
        if (next !== current) heightChangeRef.current?.(next);
        return next;
      });
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);
  useEffect(() => {
    if (initialHeight !== undefined && initialHeight !== height) {
      const next = resizeTerminalHeight(initialHeight, 0, 0, window.innerHeight, window.innerWidth);
      setHeight(next);
      if (next !== initialHeight) heightChangeRef.current?.(next);
    }
    // We intentionally react only when the persisted layout changes the initial height.
  }, [initialHeight]);
  const resizeBy = (delta: number) =>
    setHeight((current) => {
      const next = resizeTerminalHeight(
        current + delta,
        0,
        0,
        window.innerHeight,
        window.innerWidth,
      );
      heightChangeRef.current?.(next);
      return next;
    });
  return (
    <section
      className={`resizable-terminal${resizing ? ' resizable-terminal--resizing' : ''}`}
      style={{ '--terminal-height': `${String(height)}px` } as React.CSSProperties}
    >
      <div
        aria-label="Resize Agent Console height"
        aria-orientation="horizontal"
        aria-valuemax={maximumTerminalHeight(viewportHeight, viewportWidth)}
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
            const next = resizeTerminalHeight(
              active.height,
              active.pointerY,
              currentY,
              window.innerHeight,
              window.innerWidth,
            );
            setHeight(next);
            heightChangeRef.current?.(next);
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
        <pre aria-label={`Diff for ${diff.path}`} tabIndex={0}>
          {diff.patch.text}
        </pre>
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
                <pre
                  aria-label={`Output for Quality Gate ${run.gateId}`}
                  className="quality-gate-run__output"
                  tabIndex={0}
                >
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
  hidden,
  modal,
  onOpenProject,
  onSelectProject,
  projects,
  selectedProjectId,
}: {
  readonly busy: boolean;
  readonly hidden: boolean;
  readonly modal: boolean;
  readonly onOpenProject: () => void;
  readonly onSelectProject: (project: WorkspaceProjectOverview) => void;
  readonly projects: readonly WorkspaceProjectOverview[];
  readonly selectedProjectId: string | undefined;
}) {
  return (
    <aside
      {...(modal ? { 'aria-modal': true as const, role: 'dialog' as const } : {})}
      aria-label="Project navigator"
      className="workspace-sidebar"
      hidden={hidden}
      id="workspace-sidebar"
      tabIndex={-1}
    >
      <header className="workspace-sidebar__header">
        <div>
          <p className="eyebrow">Navigator</p>
          <h2>Projects</h2>
        </div>
        <kbd>Alt+1</kbd>
      </header>
      <nav className="project-navigation" aria-label="Projects">
        {projects.length === 0 ? (
          <EmptyState
            description="Open a local Git repository to add the first Project."
            icon="folder"
            title="No Projects"
          />
        ) : null}
        {projects.map((project) => (
          <button
            {...(project.project.id === selectedProjectId
              ? { 'aria-current': 'page' as const }
              : {})}
            className="project-option"
            key={project.project.id}
            onClick={() => onSelectProject(project)}
            type="button"
          >
            <WorkspaceIcon name="project" size={18} />
            <span className="project-option__body">
              <strong title={project.project.name}>{project.project.name}</strong>
              <span>
                {project.tasks.length} {project.tasks.length === 1 ? 'Task' : 'Tasks'} ·{' '}
                {project.tasks.filter(({ activeSession }) => activeSession !== undefined).length}{' '}
                active
              </span>
            </span>
            <WorkspaceIcon className="project-option__chevron" name="chevron-right" size={16} />
          </button>
        ))}
      </nav>
      <footer className="workspace-sidebar__footer">
        <button className="secondary-action" disabled={busy} onClick={onOpenProject} type="button">
          <WorkspaceIcon name="folder" size={16} />
          {busy ? 'Opening…' : 'Open Project'}
        </button>
        <span>Repositories stay local</span>
      </footer>
    </aside>
  );
}

function TaskWorkflow({
  blocked,
  phase,
}: {
  readonly blocked: boolean;
  readonly phase: TaskPhaseToken;
}) {
  const phases = Object.freeze([
    Object.freeze({ label: 'Backlog', phase: 'BACKLOG' as const }),
    Object.freeze({ label: 'Planning', phase: 'PLANNING' as const }),
    Object.freeze({ label: 'Running', phase: 'RUNNING' as const }),
    Object.freeze({ label: 'Review', phase: 'REVIEW' as const }),
    Object.freeze({ label: 'Done', phase: 'DONE' as const }),
  ]);
  const activeIndex = phases.findIndex((entry) => entry.phase === phase);
  return (
    <section aria-labelledby="task-workflow-heading" className="task-workflow">
      <header>
        <p className="eyebrow">Task workflow</p>
        <h3 id="task-workflow-heading">Lifecycle progress</h3>
      </header>
      <ol>
        {phases.map((entry, index) => {
          const state =
            index < activeIndex ? 'complete' : index === activeIndex ? 'current' : 'pending';
          return (
            <li className={`task-workflow__step task-workflow__step--${state}`} key={entry.phase}>
              <span aria-hidden="true" className="task-workflow__marker">
                {state === 'complete' ? '✓' : state === 'current' ? '◔' : '○'}
              </span>
              <span>{entry.label}</span>
              {state === 'current' ? (
                <small>{blocked ? 'Blocked by dependencies' : 'Current phase'}</small>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StateValue({
  label,
  phase,
  tone,
  value,
}: {
  readonly label: string;
  readonly phase?: string;
  readonly tone: 'session' | 'task';
  readonly value: string;
}) {
  const tokenClassName =
    phase === undefined
      ? undefined
      : tone === 'task'
        ? phaseTokenClass(phase)
        : `session-dot--${phase.trim().toLowerCase().replaceAll('_', '-')}`;
  const runtimeActive =
    tone === 'session' &&
    phase !== undefined &&
    ['STARTING', 'WAITING_INPUT', 'WORKING'].includes(phase);
  return (
    <div className={`state-value state-value--${tone}`}>
      <span>{label}</span>
      <strong className="state-value__inner">
        {tokenClassName === undefined ? null : (
          <span
            aria-hidden="true"
            className={`${tone === 'task' ? 'phase-dot' : 'session-dot'} ${tokenClassName}${runtimeActive ? ' session-dot--active' : ''}`}
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
  role,
  title,
}: {
  readonly children?: React.ReactNode;
  readonly eyebrow: string;
  readonly message: string;
  readonly role?: 'alert' | 'status';
  readonly title: string;
}) {
  return (
    <section className="workspace-message" role={role}>
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
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

function findTask(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  taskId: string | undefined,
): WorkspaceTaskOverview | undefined {
  return snapshot.overview.projects
    .flatMap((project) => project.tasks)
    .find((task) => task.task.id === taskId);
}

function findTaskSession(
  task: WorkspaceTaskOverview | undefined,
  sessionId: string | undefined,
): WorkspaceTaskOverview['activeSession'] {
  if (task === undefined || sessionId === undefined) return undefined;
  return [task.activeSession, task.latestSession, task.previousSession].find(
    (session) => session?.id === sessionId,
  );
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
  const disclosure = element?.closest('details');
  if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
  element?.focus({ preventScroll: true });
  element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scheduleTerminalFocus(): void {
  requestAnimationFrame(() => focusWorkspaceTarget('terminal'));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.closest('[role="textbox"]') !== null ||
    target.closest('[data-terminal-pane-id]') !== null
  );
}

function trapFocusWithin(event: KeyboardEvent, container: HTMLElement): void {
  const focusable = [
    ...container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    container.focus({ preventScroll: true });
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === container || !container.contains(active))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}
