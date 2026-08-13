import type { AgentWorkspaceOverview } from '@agentterm/application';

import type { TerminalSessionClient } from './terminal-controller';

export interface AgentWorkspaceClient extends TerminalSessionClient {
  approveTaskReview(input: { readonly reviewId: string; readonly taskId: string }): Promise<void>;
  loadWorkspace(): Promise<AgentWorkspaceOverview>;
  requestTaskChanges(input: { readonly reviewId: string; readonly taskId: string }): Promise<void>;
  requestTaskReview(input: { readonly taskId: string }): Promise<void>;
  retryTaskExecution(input: { readonly taskId: string }): Promise<void>;
  startTaskExecution(input: { readonly agentId: string; readonly taskId: string }): Promise<void>;
}

export type WorkspaceActionKind =
  'approve-review' | 'request-changes' | 'request-review' | 'retry-execution' | 'start-execution';

export interface WorkspaceAction {
  readonly kind: WorkspaceActionKind;
  readonly taskId: string;
}

export type WorkspaceSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly actionError: string | undefined;
      readonly activeAction: WorkspaceAction | undefined;
      readonly kind: 'ready';
      readonly overview: AgentWorkspaceOverview;
      readonly selectedAgentId: string | undefined;
      readonly selectedTaskId: string | undefined;
      readonly terminalSessionId: string | undefined;
    };

export class WorkspaceController {
  private disposed = false;
  private loadGeneration = 0;
  private readonly client: AgentWorkspaceClient;
  private readonly sink: ((snapshot: WorkspaceSnapshot) => void) | undefined;
  private actionAttempt: Promise<void> | undefined;
  public snapshot: WorkspaceSnapshot = Object.freeze({ kind: 'loading' });

  public constructor(client: AgentWorkspaceClient, sink?: (snapshot: WorkspaceSnapshot) => void) {
    this.client = client;
    this.sink = sink;
  }

  public async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.publish(Object.freeze({ kind: 'loading' }));
    try {
      const overview = await this.client.loadWorkspace();
      if (this.disposed || generation !== this.loadGeneration) {
        return;
      }
      this.publishReady(overview, undefined);
    } catch {
      if (!this.disposed && generation === this.loadGeneration) {
        this.publish(
          Object.freeze({ kind: 'error', message: 'Workspace data could not be loaded.' }),
        );
      }
    }
  }

  public async refresh(): Promise<void> {
    const generation = ++this.loadGeneration;
    const requestedTaskId =
      this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : undefined;
    try {
      const overview = await this.client.loadWorkspace();
      if (!this.disposed && generation === this.loadGeneration) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : requestedTaskId;
        this.publishReady(overview, preferredTaskId);
      }
    } catch {
      if (!this.disposed && generation === this.loadGeneration) {
        if (this.snapshot.kind === 'ready') {
          this.publish(
            Object.freeze({
              ...this.snapshot,
              actionError: 'Workspace status could not be refreshed.',
            }),
          );
        } else {
          this.publish(
            Object.freeze({ kind: 'error', message: 'Workspace data could not be loaded.' }),
          );
        }
      }
    }
  }

  public selectTask(taskId: string): void {
    if (this.snapshot.kind !== 'ready' || !containsTask(this.snapshot.overview, taskId)) {
      return;
    }
    const selectedTask = findTask(this.snapshot.overview, taskId);
    this.publish(
      Object.freeze({
        ...this.snapshot,
        actionError: undefined,
        selectedTaskId: taskId,
        terminalSessionId: selectedTask?.activeSession?.id,
      }),
    );
  }

  public selectAgent(agentId: string): void {
    if (this.snapshot.kind !== 'ready' || !isAvailableAgentId(this.snapshot.overview, agentId)) {
      return;
    }
    this.publish(
      Object.freeze({
        ...this.snapshot,
        actionError: undefined,
        selectedAgentId: agentId,
      }),
    );
  }

  public startSelectedTask(): Promise<void> {
    return this.executeSelectedAction('start-execution');
  }

  public retrySelectedTask(): Promise<void> {
    return this.executeSelectedAction('retry-execution');
  }

  public requestSelectedTaskReview(): Promise<void> {
    return this.executeSelectedAction('request-review');
  }

  public approveSelectedTaskReview(): Promise<void> {
    return this.executeSelectedAction('approve-review');
  }

  public requestSelectedTaskChanges(): Promise<void> {
    return this.executeSelectedAction('request-changes');
  }

  private executeSelectedAction(kind: WorkspaceActionKind): Promise<void> {
    if (this.actionAttempt !== undefined) {
      return this.actionAttempt;
    }
    if (this.snapshot.kind !== 'ready' || this.snapshot.selectedTaskId === undefined) {
      return Promise.resolve();
    }

    const taskId = this.snapshot.selectedTaskId;
    const selectedAgentId = this.snapshot.selectedAgentId;
    const selected = findTask(this.snapshot.overview, taskId);
    if (selected === undefined || !canRunAction(selected, kind)) {
      return Promise.resolve();
    }

    const reviewId =
      kind === 'approve-review' || kind === 'request-changes'
        ? selected.latestReview?.id
        : undefined;
    if ((kind === 'approve-review' || kind === 'request-changes') && reviewId === undefined) {
      return Promise.resolve();
    }
    if (kind === 'start-execution' && selectedAgentId === undefined) {
      return Promise.resolve();
    }

    const attempt = this.performAction({ kind, taskId }, reviewId, selectedAgentId);
    this.actionAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.actionAttempt === attempt) {
          this.actionAttempt = undefined;
        }
      })
      .catch(() => undefined);
    return attempt;
  }

  public dispose(): void {
    this.disposed = true;
    this.loadGeneration += 1;
  }

  private async performAction(
    action: WorkspaceAction,
    reviewId: string | undefined,
    agentId: string | undefined,
  ): Promise<void> {
    const current = this.snapshot;
    if (current.kind !== 'ready') {
      return;
    }
    let sideEffectCompleted = false;
    this.publish(
      Object.freeze({
        ...current,
        actionError: undefined,
        activeAction: Object.freeze(action),
      }),
    );
    try {
      await runWorkspaceAction(this.client, action, reviewId, agentId);
      sideEffectCompleted = true;
      const overview = await this.client.loadWorkspace();
      if (!this.disposed) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : action.taskId;
        this.publishReady(overview, preferredTaskId);
      }
    } catch {
      if (!this.disposed) {
        const latest = this.snapshot.kind === 'ready' ? this.snapshot : current;
        this.publish(
          Object.freeze({
            ...latest,
            actionError: sideEffectCompleted
              ? refreshFailureMessage(action.kind)
              : actionFailureMessage(action.kind),
            activeAction: undefined,
            selectedTaskId: latest.selectedTaskId ?? action.taskId,
          }),
        );
      }
    }
  }

  private publishReady(
    overview: AgentWorkspaceOverview,
    preferredTaskId: string | undefined,
  ): void {
    const selectedTaskId = selectAvailableTaskId(overview, preferredTaskId);
    const selectedTask = findTask(overview, selectedTaskId);
    const preferredAgentId =
      this.snapshot.kind === 'ready' ? this.snapshot.selectedAgentId : undefined;
    const selectedAgentId = selectAvailableAgentId(overview, preferredAgentId);
    const previousTerminalSessionId =
      this.snapshot.kind === 'ready' && this.snapshot.selectedTaskId === selectedTaskId
        ? this.snapshot.terminalSessionId
        : undefined;
    this.publish(
      Object.freeze({
        actionError: undefined,
        activeAction: undefined,
        kind: 'ready',
        overview,
        selectedAgentId,
        selectedTaskId,
        terminalSessionId: selectedTask?.activeSession?.id ?? previousTerminalSessionId,
      }),
    );
  }

  private publish(snapshot: WorkspaceSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.snapshot = snapshot;
    this.sink?.(snapshot);
  }
}

async function runWorkspaceAction(
  client: AgentWorkspaceClient,
  action: WorkspaceAction,
  reviewId: string | undefined,
  agentId: string | undefined,
): Promise<void> {
  switch (action.kind) {
    case 'start-execution':
      await client.startTaskExecution({ agentId: requireAgentId(agentId), taskId: action.taskId });
      return;
    case 'retry-execution':
      await client.retryTaskExecution({ taskId: action.taskId });
      return;
    case 'request-review':
      await client.requestTaskReview({ taskId: action.taskId });
      return;
    case 'approve-review':
      await client.approveTaskReview({
        reviewId: requireReviewId(reviewId),
        taskId: action.taskId,
      });
      return;
    case 'request-changes':
      await client.requestTaskChanges({
        reviewId: requireReviewId(reviewId),
        taskId: action.taskId,
      });
  }
}

function requireAgentId(agentId: string | undefined): string {
  if (agentId === undefined) {
    throw new TypeError('An available coding agent is required.');
  }
  return agentId;
}

function canRunAction(
  task: AgentWorkspaceOverview['projects'][number]['tasks'][number],
  kind: WorkspaceActionKind,
): boolean {
  switch (kind) {
    case 'start-execution':
      return task.canStartExecution;
    case 'retry-execution':
      return task.canRetryExecution;
    case 'request-review':
      return task.canRequestReview;
    case 'approve-review':
      return task.canApproveReview && task.latestReview?.status === 'PENDING';
    case 'request-changes':
      return task.canRequestChanges && task.latestReview?.status === 'PENDING';
  }
}

function requireReviewId(reviewId: string | undefined): string {
  if (reviewId === undefined) {
    throw new TypeError('A pending Task Review is required.');
  }
  return reviewId;
}

function actionFailureMessage(kind: WorkspaceActionKind): string {
  switch (kind) {
    case 'start-execution':
      return 'Task execution could not be started.';
    case 'retry-execution':
      return 'Task execution could not be retried.';
    case 'request-review':
      return 'Task review could not be requested.';
    case 'approve-review':
      return 'Task review could not be approved.';
    case 'request-changes':
      return 'Task changes could not be requested.';
  }
}

function refreshFailureMessage(kind: WorkspaceActionKind): string {
  switch (kind) {
    case 'start-execution':
    case 'retry-execution':
      return 'Task execution started, but workspace status could not be refreshed.';
    case 'request-review':
      return 'Task review requested, but workspace status could not be refreshed.';
    case 'approve-review':
      return 'Task review approved, but workspace status could not be refreshed.';
    case 'request-changes':
      return 'Task changes requested, but workspace status could not be refreshed.';
  }
}

function containsTask(overview: AgentWorkspaceOverview, taskId: string): boolean {
  return findTask(overview, taskId) !== undefined;
}

function findTask(
  overview: AgentWorkspaceOverview,
  taskId: string | undefined,
): AgentWorkspaceOverview['projects'][number]['tasks'][number] | undefined {
  return overview.projects
    .flatMap((project) => project.tasks)
    .find((task) => task.task.id === taskId);
}

function selectAvailableTaskId(
  overview: AgentWorkspaceOverview,
  preferredTaskId: string | undefined,
): string | undefined {
  if (preferredTaskId !== undefined && containsTask(overview, preferredTaskId)) {
    return preferredTaskId;
  }
  return overview.projects.flatMap((project) => project.tasks)[0]?.task.id;
}

function selectAvailableAgentId(
  overview: AgentWorkspaceOverview,
  preferredAgentId: string | undefined,
): string | undefined {
  const available = overview.agents.filter((agent) => agent.kind === 'available');
  if (preferredAgentId !== undefined && available.some((agent) => agent.id === preferredAgentId)) {
    return preferredAgentId;
  }
  return available[0]?.id;
}

function isAvailableAgentId(overview: AgentWorkspaceOverview, agentId: string): boolean {
  return overview.agents.some((agent) => agent.id === agentId && agent.kind === 'available');
}
