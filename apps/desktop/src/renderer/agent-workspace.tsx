import { useEffect, useState } from 'react';

import type { WorkspaceProjectOverview, WorkspaceTaskOverview } from '@agentterm/application';

import { TerminalRenderer } from './terminal-renderer';
import {
  WorkspaceController,
  type AgentWorkspaceClient,
  type WorkspaceSnapshot,
} from './workspace-controller';

export interface AgentWorkspaceProps {
  readonly client?: AgentWorkspaceClient;
}

export interface AgentWorkspaceViewProps extends AgentWorkspaceProps {
  readonly onRefresh: () => void;
  readonly onRetry: () => void;
  readonly onRetryTask: () => void;
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
      onRefresh={() => void controller?.refresh()}
      onRetry={() => void controller?.load()}
      onRetryTask={() => void controller?.retrySelectedTask()}
      onSelectTask={(taskId) => controller?.selectTask(taskId)}
      onStartTask={() => void controller?.startSelectedTask()}
      snapshot={snapshot}
    />
  );
}

export function AgentWorkspaceView({
  client,
  onRefresh,
  onRetry,
  onRetryTask,
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
            <div className="task-actions">
              <button className="secondary-action" onClick={onRefresh} type="button">
                Refresh
              </button>
              <button
                className="primary-action"
                disabled={!canExecute(selected) || snapshot.startingTaskId !== undefined}
                onClick={selected.canRetryExecution ? onRetryTask : onStartTask}
                title={startActionTitle(selected)}
                type="button"
              >
                {snapshot.startingTaskId === selected.task.id
                  ? selected.canRetryExecution
                    ? 'Retrying…'
                    : 'Starting…'
                  : selected.canRetryExecution
                    ? 'Retry execution'
                    : 'Start execution'}
              </button>
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
                  : `${selected.latestSession.agentId} · ${selected.latestSession.id}`}
              </strong>
            </div>
            {selected.previousSession === undefined ? null : (
              <div className="previous-session">
                <span>Previous session</span>
                <strong>
                  {selected.previousSession.status} · {selected.previousSession.id}
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

function canExecute(task: WorkspaceTaskOverview): boolean {
  return task.canStartExecution || task.canRetryExecution;
}

function startActionTitle(task: WorkspaceTaskOverview): string {
  if (task.canRetryExecution) {
    return 'Reuse the primary Task Worktree and launch a new Agent Session attempt.';
  }
  return task.canStartExecution
    ? 'Provision or reuse the Task Worktree and launch a new Agent Session.'
    : task.activeSession === undefined
      ? 'The Task must be in PLANNING or RUNNING before execution can start.'
      : 'The Task already has an active Agent Session.';
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
