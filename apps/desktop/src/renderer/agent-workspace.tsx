import { useEffect, useRef, useState } from 'react';

import type {
  AgentWorkspaceOverview,
  PullRequestBranchReadinessFailure,
  TaskFileChange,
  TaskFileDiff,
  WorkspaceProjectOverview,
  WorkspaceTaskOverview,
} from '@agentterm/application';

import { WorkspaceCommandPalette } from './command-palette';
import { WorkspaceTerminals } from './workspace-terminals';
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
  readonly onCreatePullRequest: () => void;
  readonly onCloseWorkspacePane: (paneId: string) => void;
  readonly onCloseWorkspaceTab: (tabId: string) => void;
  readonly onCycleWorkspacePane: (delta: -1 | 1) => void;
  readonly onCycleWorkspaceTab: (delta: -1 | 1) => void;
  readonly onPushTaskBranch: () => void;
  readonly onRefresh: () => void;
  readonly onRequestChanges: () => void;
  readonly onRequestReview: () => void;
  readonly onRetry: () => void;
  readonly onRetryTask: () => void;
  readonly onRunQualityGate: (gateId: string) => void;
  readonly onSelectAgent?: (agentId: string) => void;
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
      onCreatePullRequest={() => void controller?.createSelectedTaskPullRequest()}
      onCloseWorkspacePane={(paneId) => controller?.closeWorkspacePane(paneId)}
      onCloseWorkspaceTab={(tabId) => controller?.closeWorkspaceTab(tabId)}
      onCycleWorkspacePane={(delta) => controller?.cycleWorkspacePane(delta)}
      onCycleWorkspaceTab={(delta) => controller?.cycleWorkspaceTab(delta)}
      onRefresh={() => void controller?.refresh()}
      onPushTaskBranch={() => void controller?.pushSelectedTaskBranch()}
      onRequestChanges={() => void controller?.requestSelectedTaskChanges()}
      onRequestReview={() => void controller?.requestSelectedTaskReview()}
      onRetry={() => void controller?.load()}
      onRetryTask={() => void controller?.retrySelectedTask()}
      onRunQualityGate={(gateId) => void controller?.runSelectedQualityGate(gateId)}
      onSelectAgent={(agentId) => controller?.selectAgent(agentId)}
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
  onCreatePullRequest,
  onCloseWorkspacePane,
  onCloseWorkspaceTab,
  onCycleWorkspacePane,
  onCycleWorkspaceTab,
  onRefresh,
  onPushTaskBranch,
  onRequestChanges,
  onRequestReview,
  onRetry,
  onRetryTask,
  onRunQualityGate,
  onSelectAgent,
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
  const paletteReturnFocus = useRef<HTMLElement | null>(null);

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
    document.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown, true);
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
  if (snapshot.overview.projects.length === 0) {
    return (
      <WorkspaceMessage
        eyebrow="Empty workspace"
        message="No Projects yet. Open a local Git Project to begin."
      />
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
    <main className="workspace-shell">
      <WorkspaceSidebar
        projects={snapshot.overview.projects}
        selectedTaskId={snapshot.selectedTaskId}
        onSelectTask={onSelectTask}
      />
      {selected === undefined || selectedProject === undefined ? (
        <WorkspaceMessage
          eyebrow="No Task selected"
          message="Choose a Task from the sidebar to inspect its execution state."
        />
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
              <h2>{selected.task.title}</h2>
              <p className="task-id">{selected.task.id}</p>
            </div>
            <div className="task-actions" aria-busy={actionsBusy}>
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
                className="primary-action"
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
              </button>
              {selected.canAcceptPlan && selected.latestPlan !== undefined ? (
                <button
                  className="primary-action"
                  disabled={actionsBusy}
                  onClick={onAcceptPlan}
                  type="button"
                >
                  {isSelectedAction(snapshot, selected.task.id, 'accept-plan')
                    ? 'Accepting Plan…'
                    : 'Accept Plan and enter RUNNING'}
                </button>
              ) : null}
              {selected.canRequestReview ? (
                <button
                  className="secondary-action"
                  disabled={actionsBusy}
                  onClick={onRequestReview}
                  type="button"
                >
                  {isSelectedAction(snapshot, selected.task.id, 'request-review')
                    ? 'Starting review...'
                    : 'Start review'}
                </button>
              ) : null}
              {selected.canRequestChanges ? (
                <button
                  className="secondary-action"
                  disabled={actionsBusy}
                  onClick={onRequestChanges}
                  type="button"
                >
                  {isSelectedAction(snapshot, selected.task.id, 'request-changes')
                    ? 'Requesting changes...'
                    : 'Request changes'}
                </button>
              ) : null}
              {selected.canApproveReview ? (
                <button
                  className="primary-action"
                  disabled={actionsBusy}
                  onClick={onApproveReview}
                  type="button"
                >
                  {isSelectedAction(snapshot, selected.task.id, 'approve-review')
                    ? 'Approving...'
                    : 'Approve and mark done'}
                </button>
              ) : null}
            </div>
          </header>

          {snapshot.actionError === undefined ? null : (
            <p className="inline-error" role="alert">
              {snapshot.actionError}
            </p>
          )}

          <div className="state-strip" aria-label="Task and Agent Session states">
            <StateValue label="Task phase" value={selected.task.phase} tone="task" />
            <StateValue
              label="Dependencies"
              value={
                selected.blocked ? 'BLOCKED' : selected.dependencies.length === 0 ? 'NONE' : 'READY'
              }
              tone="task"
            />
            <StateValue
              label="Active session"
              value={selected.activeSession?.status ?? 'NONE'}
              tone="session"
            />
            <StateValue
              label="Latest session"
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

          <TaskDependencies blocked={selected.blocked} dependencies={selected.dependencies} />
          <PullRequestPanel
            actionsBusy={actionsBusy}
            inspection={snapshot.pullRequestInspection}
            onCreate={onCreatePullRequest}
            onPush={onPushTaskBranch}
            taskId={selected.task.id}
            activeAction={snapshot.activeAction}
          />
          <PlanningSummary plan={selected.latestPlan} />
          <ChangeInspector
            inspection={snapshot.changeInspection}
            onSelectChange={onSelectTaskChange}
          />
          <ReviewHistory reviews={selected.reviewHistory} />
          <ArtifactHistory artifacts={selected.artifacts} />
          <QualityGateHistory runs={selected.qualityGateRuns} />

          <WorkspaceTerminals
            {...(client === undefined ? {} : { client })}
            layout={snapshot.layout}
            onActivatePane={onSelectWorkspacePane}
            onActivateTab={onSelectWorkspaceTab}
            onClosePane={onCloseWorkspacePane}
            onCloseTab={onCloseWorkspaceTab}
            onRuntimeEvent={(event) => {
              if (event.kind !== 'output') {
                onRefresh();
              }
            }}
            onSplit={onSplitTerminal}
            overview={snapshot.overview}
          />
          <WorkspaceCommandPalette
            commands={commands}
            onAction={handlePaletteAction}
            onRun={runPaletteCommand}
            state={paletteState}
          />
        </section>
      )}
    </main>
  );
}

function PullRequestPanel({
  actionsBusy,
  activeAction,
  inspection,
  onCreate,
  onPush,
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
            <p className="pull-request-panel__message">
              Last recorded PR #{inspection.result.pullRequest.number} ·{' '}
              {inspection.result.pullRequest.status} · {inspection.result.pullRequest.url}
            </p>
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
                : inspection.result.pullRequest === undefined
                  ? 'Create Pull Request'
                  : 'Refresh / reopen Pull Request'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
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
  onSelectTask,
  projects,
  selectedTaskId,
}: {
  readonly onSelectTask: (taskId: string) => void;
  readonly projects: readonly WorkspaceProjectOverview[];
  readonly selectedTaskId: string | undefined;
}) {
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
      </header>
      <nav className="project-navigation" aria-label="Projects and Tasks">
        {projects.map((project) => (
          <section className="project-group" key={project.project.id}>
            <header className="project-group__header">
              <h2>{project.project.name}</h2>
              <span>{project.tasks.length}</span>
            </header>
            {project.tasks.length === 0 ? (
              <p className="project-empty">No Tasks</p>
            ) : (
              <ul className="task-list">
                {project.tasks.map((task) => (
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
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </nav>
    </aside>
  );
}

function StateValue({
  label,
  tone,
  value,
}: {
  readonly label: string;
  readonly tone: 'session' | 'task';
  readonly value: string;
}) {
  return (
    <div className={`state-value state-value--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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
