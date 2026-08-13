import { useEffect, useState } from 'react';

import type {
  AgentWorkspaceOverview,
  WorkspaceProjectOverview,
  WorkspaceTaskOverview,
} from '@agentterm/application';

import { TerminalRenderer } from './terminal-renderer';
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
  readonly onApproveReview: () => void;
  readonly onRefresh: () => void;
  readonly onRequestChanges: () => void;
  readonly onRequestReview: () => void;
  readonly onRetry: () => void;
  readonly onRetryTask: () => void;
  readonly onSelectAgent?: (agentId: string) => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onStartTask: () => void;
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
      onApproveReview={() => void controller?.approveSelectedTaskReview()}
      onRefresh={() => void controller?.refresh()}
      onRequestChanges={() => void controller?.requestSelectedTaskChanges()}
      onRequestReview={() => void controller?.requestSelectedTaskReview()}
      onRetry={() => void controller?.load()}
      onRetryTask={() => void controller?.retrySelectedTask()}
      onSelectAgent={(agentId) => controller?.selectAgent(agentId)}
      onSelectTask={(taskId) => controller?.selectTask(taskId)}
      onStartTask={() => void controller?.startSelectedTask()}
      snapshot={snapshot}
    />
  );
}

export function AgentWorkspaceView({
  client,
  onApproveReview,
  onRefresh,
  onRequestChanges,
  onRequestReview,
  onRetry,
  onRetryTask,
  onSelectAgent,
  onSelectTask,
  onStartTask,
  snapshot,
}: AgentWorkspaceViewProps) {
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
        <section className="workspace-main" aria-label="Selected Task workspace">
          <header className="task-header">
            <div className="task-header__identity">
              <p className="breadcrumb">{selectedProject.project.name}</p>
              <h2>{selected.task.title}</h2>
              <p className="task-id">{selected.task.id}</p>
            </div>
            <div className="task-actions" aria-busy={actionsBusy}>
              <label className="agent-selector">
                <span>Agent for fresh start</span>
                <select
                  aria-label="Coding agent"
                  disabled={
                    actionsBusy ||
                    !selected.canStartExecution ||
                    snapshot.overview.agents.every((agent) => agent.kind !== 'available')
                  }
                  title="Used when starting a fresh Agent Session. Retry keeps the previous Session's agent."
                  onChange={(event) => onSelectAgent?.(event.currentTarget.value)}
                  value={snapshot.selectedAgentId ?? ''}
                >
                  {snapshot.selectedAgentId === undefined ? (
                    <option value="">No available agent</option>
                  ) : null}
                  {snapshot.overview.agents.map((agent) => (
                    <option disabled={agent.kind === 'unavailable'} key={agent.id} value={agent.id}>
                      {agent.displayName} ({agent.id})
                      {agent.kind === 'unavailable' ? ' — unavailable' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <button className="secondary-action" onClick={onRefresh} type="button">
                Refresh
              </button>
              <button
                className="primary-action"
                disabled={!canExecute(selected, snapshot.selectedAgentId) || actionsBusy}
                onClick={selected.canRetryExecution ? onRetryTask : onStartTask}
                title={startActionTitle(selected, snapshot.selectedAgentId)}
                type="button"
              >
                {isExecutionActionForTask(snapshot, selected.task.id)
                  ? selected.canRetryExecution
                    ? 'Retrying…'
                    : 'Starting…'
                  : selected.canRetryExecution
                    ? 'Retry execution'
                    : 'Start execution'}
              </button>
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

          <ReviewHistory reviews={selected.reviewHistory} />
          <ArtifactHistory artifacts={selected.artifacts} />
          <QualityGateHistory runs={selected.qualityGateRuns} />

          <TerminalRenderer
            {...(client === undefined ? {} : { client })}
            {...(snapshot.terminalSessionId === undefined
              ? {}
              : { sessionId: snapshot.terminalSessionId })}
            onRuntimeEvent={(event) => {
              if (event.kind !== 'output') {
                onRefresh();
              }
            }}
          />
        </section>
      )}
    </main>
  );
}

function ReviewHistory({ reviews }: { readonly reviews: WorkspaceTaskOverview['reviewHistory'] }) {
  return (
    <section className="review-history" aria-labelledby="review-history-heading">
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
    <section className="quality-gates" aria-labelledby="quality-gates-heading">
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
    <section className="artifact-history" aria-label="Execution artifacts">
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
    <aside className="workspace-sidebar">
      <header className="workspace-brand">
        <span className="brand-mark" aria-hidden="true">
          AT
        </span>
        <div>
          <p className="eyebrow">Agent workspace</p>
          <h1>AgentTerm</h1>
        </div>
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

function canExecute(task: WorkspaceTaskOverview, selectedAgentId: string | undefined): boolean {
  return task.canRetryExecution || (task.canStartExecution && selectedAgentId !== undefined);
}

function isExecutionActionForTask(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  taskId: string,
): boolean {
  return (
    isSelectedAction(snapshot, taskId, 'start-execution') ||
    isSelectedAction(snapshot, taskId, 'retry-execution')
  );
}

function isSelectedAction(
  snapshot: Extract<WorkspaceSnapshot, { kind: 'ready' }>,
  taskId: string,
  kind: WorkspaceActionKind,
): boolean {
  return snapshot.activeAction?.taskId === taskId && snapshot.activeAction.kind === kind;
}

function startActionTitle(
  task: WorkspaceTaskOverview,
  selectedAgentId: string | undefined,
): string {
  if (task.canRetryExecution) {
    return 'Reuse the primary Task Worktree and launch a new Agent Session attempt.';
  }
  if (task.canStartExecution && selectedAgentId === undefined) {
    return 'No configured coding agent is currently available.';
  }
  return task.canStartExecution
    ? 'Provision or reuse the Task Worktree and launch a new Agent Session.'
    : task.activeSession === undefined
      ? 'The Task must be in PLANNING or RUNNING before execution can start.'
      : 'The Task already has an active Agent Session.';
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
