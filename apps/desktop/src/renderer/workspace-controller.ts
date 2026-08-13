import type {
  AgentWorkspaceOverview,
  GetTaskFileDiffInput,
  TaskChangeSet,
  TaskFileChange,
  TaskFileDiff,
  TaskPullRequestState,
} from '@agentterm/application';

import type { TerminalSessionClient } from './terminal-controller';

export interface AgentWorkspaceClient extends TerminalSessionClient {
  acceptTaskPlan(input: { readonly planId: string; readonly taskId: string }): Promise<void>;
  approveTaskReview(input: { readonly reviewId: string; readonly taskId: string }): Promise<void>;
  getTaskFileDiff(input: GetTaskFileDiffInput): Promise<TaskFileDiff>;
  createTaskPullRequest(input: { readonly taskId: string }): Promise<void>;
  inspectTaskPullRequest(input: { readonly taskId: string }): Promise<TaskPullRequestState>;
  listTaskChanges(input: { readonly taskId: string }): Promise<TaskChangeSet>;
  loadWorkspace(): Promise<AgentWorkspaceOverview>;
  requestTaskChanges(input: { readonly reviewId: string; readonly taskId: string }): Promise<void>;
  requestTaskReview(input: { readonly taskId: string }): Promise<void>;
  pushTaskBranch(input: { readonly taskId: string }): Promise<void>;
  retryTaskExecution(input: { readonly agentId: string; readonly taskId: string }): Promise<void>;
  startTaskExecution(input: { readonly agentId: string; readonly taskId: string }): Promise<void>;
  startTaskPlanning(input: { readonly agentId: string; readonly taskId: string }): Promise<void>;
}

export type WorkspacePullRequestInspection =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly taskId: string }
  | { readonly kind: 'error'; readonly message: string; readonly taskId: string }
  | { readonly kind: 'ready'; readonly result: TaskPullRequestState; readonly taskId: string };

export type WorkspaceChangeInspection =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly taskId: string }
  | { readonly kind: 'error'; readonly message: string; readonly taskId: string }
  | {
      readonly diffError: string | undefined;
      readonly diffLoading: boolean;
      readonly kind: 'ready';
      readonly result: TaskChangeSet;
      readonly selectedDiff: TaskFileDiff | undefined;
      readonly selectedFile: TaskFileChange | undefined;
      readonly taskId: string;
    };

export type WorkspaceActionKind =
  | 'accept-plan'
  | 'approve-review'
  | 'create-pull-request'
  | 'push-branch'
  | 'request-changes'
  | 'request-review'
  | 'retry-execution'
  | 'start-execution'
  | 'start-planning';

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
      readonly changeInspection?: WorkspaceChangeInspection;
      readonly kind: 'ready';
      readonly overview: AgentWorkspaceOverview;
      readonly pullRequestInspection?: WorkspacePullRequestInspection;
      readonly selectedAgentId: string | undefined;
      readonly selectedTaskId: string | undefined;
      readonly terminalSessionId: string | undefined;
    };

export class WorkspaceController {
  private disposed = false;
  private changeGeneration = 0;
  private pullRequestGeneration = 0;
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
      await this.loadSelectedTaskEvidence();
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
        await this.loadSelectedTaskEvidence();
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
        changeInspection: Object.freeze({ kind: 'idle' }),
        pullRequestInspection: Object.freeze({ kind: 'idle' }),
        selectedTaskId: taskId,
        terminalSessionId: selectedTask?.activeSession?.id,
      }),
    );
    void this.loadSelectedTaskChanges();
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

  public startSelectedPlanning(): Promise<void> {
    return this.executeSelectedAction('start-planning');
  }

  public acceptSelectedPlan(): Promise<void> {
    return this.executeSelectedAction('accept-plan');
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

  public pushSelectedTaskBranch(): Promise<void> {
    return this.executeSelectedAction('push-branch');
  }

  public createSelectedTaskPullRequest(): Promise<void> {
    return this.executeSelectedAction('create-pull-request');
  }

  public async selectTaskChange(change: TaskFileChange): Promise<void> {
    const current = this.snapshot;
    const inspection = current.kind === 'ready' ? current.changeInspection : undefined;

    if (
      current.kind !== 'ready' ||
      inspection?.kind !== 'ready' ||
      !inspection.result.files.some((candidate) => sameFileChange(candidate, change))
    ) {
      return;
    }

    const generation = ++this.changeGeneration;
    this.publish(
      Object.freeze({
        ...current,
        changeInspection: Object.freeze({
          ...inspection,
          diffError: undefined,
          diffLoading: true,
          selectedDiff: undefined,
          selectedFile: change,
        }),
      }),
    );

    try {
      const selectedDiff = await this.client.getTaskFileDiff({
        area: change.area,
        path: change.path,
        ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
        taskId: inspection.taskId,
      });
      if (!this.isCurrentChangeRequest(generation, inspection.taskId)) {
        return;
      }
      const latest = this.snapshot;
      if (latest.kind !== 'ready' || latest.changeInspection?.kind !== 'ready') {
        return;
      }
      this.publish(
        Object.freeze({
          ...latest,
          changeInspection: Object.freeze({
            ...latest.changeInspection,
            diffLoading: false,
            selectedDiff,
          }),
        }),
      );
    } catch {
      if (!this.isCurrentChangeRequest(generation, inspection.taskId)) {
        return;
      }
      const latest = this.snapshot;
      if (latest.kind !== 'ready' || latest.changeInspection?.kind !== 'ready') {
        return;
      }
      this.publish(
        Object.freeze({
          ...latest,
          changeInspection: Object.freeze({
            ...latest.changeInspection,
            diffError: 'The selected file diff could not be loaded.',
            diffLoading: false,
          }),
        }),
      );
    }
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
    if (
      selected === undefined ||
      !canRunAction(selected, kind, this.snapshot.pullRequestInspection)
    ) {
      return Promise.resolve();
    }

    const evidenceId =
      kind === 'approve-review' || kind === 'request-changes'
        ? selected.latestReview?.id
        : kind === 'accept-plan'
          ? selected.latestPlan?.id
          : undefined;
    if (
      (kind === 'approve-review' || kind === 'request-changes' || kind === 'accept-plan') &&
      evidenceId === undefined
    ) {
      return Promise.resolve();
    }
    if (
      (kind === 'start-execution' || kind === 'retry-execution' || kind === 'start-planning') &&
      selectedAgentId === undefined
    ) {
      return Promise.resolve();
    }

    const attempt = this.performAction({ kind, taskId }, evidenceId, selectedAgentId);
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
    this.changeGeneration += 1;
    this.pullRequestGeneration += 1;
  }

  private async performAction(
    action: WorkspaceAction,
    evidenceId: string | undefined,
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
      await runWorkspaceAction(this.client, action, evidenceId, agentId);
      sideEffectCompleted = true;
      const overview = await this.client.loadWorkspace();
      if (!this.disposed) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : action.taskId;
        this.publishReady(overview, preferredTaskId);
        await this.loadSelectedTaskEvidence();
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
        changeInspection: Object.freeze({ kind: 'idle' }),
        kind: 'ready',
        overview,
        pullRequestInspection: Object.freeze({ kind: 'idle' }),
        selectedAgentId,
        selectedTaskId,
        terminalSessionId: selectedTask?.activeSession?.id ?? previousTerminalSessionId,
      }),
    );
  }

  private async loadSelectedTaskEvidence(): Promise<void> {
    await Promise.all([this.loadSelectedTaskChanges(), this.loadSelectedTaskPullRequest()]);
  }

  private async loadSelectedTaskChanges(): Promise<void> {
    const current = this.snapshot;
    if (current.kind !== 'ready' || current.selectedTaskId === undefined) {
      return;
    }

    const taskId = current.selectedTaskId;
    const generation = ++this.changeGeneration;
    this.publish(
      Object.freeze({
        ...current,
        changeInspection: Object.freeze({ kind: 'loading', taskId }),
      }),
    );

    try {
      const result = await this.client.listTaskChanges({ taskId });
      if (!this.isCurrentChangeRequest(generation, taskId)) {
        return;
      }
      const latest = this.snapshot;
      if (latest.kind !== 'ready') {
        return;
      }
      this.publish(
        Object.freeze({
          ...latest,
          changeInspection: Object.freeze({
            diffError: undefined,
            diffLoading: false,
            kind: 'ready',
            result,
            selectedDiff: undefined,
            selectedFile: undefined,
            taskId,
          }),
        }),
      );
    } catch {
      if (!this.isCurrentChangeRequest(generation, taskId)) {
        return;
      }
      const latest = this.snapshot;
      if (latest.kind !== 'ready') {
        return;
      }
      this.publish(
        Object.freeze({
          ...latest,
          changeInspection: Object.freeze({
            kind: 'error',
            message: 'Task changes could not be loaded.',
            taskId,
          }),
        }),
      );
    }
  }

  private isCurrentChangeRequest(generation: number, taskId: string): boolean {
    return (
      !this.disposed &&
      generation === this.changeGeneration &&
      this.snapshot.kind === 'ready' &&
      this.snapshot.selectedTaskId === taskId
    );
  }

  private async loadSelectedTaskPullRequest(): Promise<void> {
    const current = this.snapshot;
    if (current.kind !== 'ready' || current.selectedTaskId === undefined) return;
    const taskId = current.selectedTaskId;
    const generation = ++this.pullRequestGeneration;
    this.publish(
      Object.freeze({
        ...current,
        pullRequestInspection: Object.freeze({ kind: 'loading', taskId }),
      }),
    );
    try {
      const result = await this.client.inspectTaskPullRequest({ taskId });
      if (!this.isCurrentPullRequest(generation, taskId)) return;
      const latest = this.snapshot;
      if (latest.kind !== 'ready') return;
      this.publish(
        Object.freeze({
          ...latest,
          pullRequestInspection: Object.freeze({ kind: 'ready', result, taskId }),
        }),
      );
    } catch {
      if (!this.isCurrentPullRequest(generation, taskId)) return;
      const latest = this.snapshot;
      if (latest.kind !== 'ready') return;
      this.publish(
        Object.freeze({
          ...latest,
          pullRequestInspection: Object.freeze({
            kind: 'error',
            message: 'Pull Request status could not be loaded.',
            taskId,
          }),
        }),
      );
    }
  }

  private isCurrentPullRequest(generation: number, taskId: string): boolean {
    return (
      !this.disposed &&
      generation === this.pullRequestGeneration &&
      this.snapshot.kind === 'ready' &&
      this.snapshot.selectedTaskId === taskId
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
  evidenceId: string | undefined,
  agentId: string | undefined,
): Promise<void> {
  switch (action.kind) {
    case 'start-planning':
      await client.startTaskPlanning({ agentId: requireAgentId(agentId), taskId: action.taskId });
      return;
    case 'accept-plan':
      await client.acceptTaskPlan({ planId: requirePlanId(evidenceId), taskId: action.taskId });
      return;
    case 'start-execution':
      await client.startTaskExecution({ agentId: requireAgentId(agentId), taskId: action.taskId });
      return;
    case 'retry-execution':
      await client.retryTaskExecution({ agentId: requireAgentId(agentId), taskId: action.taskId });
      return;
    case 'request-review':
      await client.requestTaskReview({ taskId: action.taskId });
      return;
    case 'approve-review':
      await client.approveTaskReview({
        reviewId: requireReviewId(evidenceId),
        taskId: action.taskId,
      });
      return;
    case 'request-changes':
      await client.requestTaskChanges({
        reviewId: requireReviewId(evidenceId),
        taskId: action.taskId,
      });
      return;
    case 'push-branch':
      await client.pushTaskBranch({ taskId: action.taskId });
      return;
    case 'create-pull-request':
      await client.createTaskPullRequest({ taskId: action.taskId });
      return;
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
  pullRequestInspection: WorkspacePullRequestInspection | undefined,
): boolean {
  switch (kind) {
    case 'start-planning':
      return task.canStartPlanning || task.canRevisePlan;
    case 'accept-plan':
      return task.canAcceptPlan && task.latestPlan !== undefined;
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
    case 'push-branch':
      return pullRequestInspection?.kind === 'ready' && pullRequestInspection.result.canPush;
    case 'create-pull-request':
      return (
        pullRequestInspection?.kind === 'ready' && pullRequestInspection.result.canCreatePullRequest
      );
  }
}

function requirePlanId(planId: string | undefined): string {
  if (planId === undefined) {
    throw new TypeError('A valid latest Plan is required.');
  }
  return planId;
}

function requireReviewId(reviewId: string | undefined): string {
  if (reviewId === undefined) {
    throw new TypeError('A pending Task Review is required.');
  }
  return reviewId;
}

function actionFailureMessage(kind: WorkspaceActionKind): string {
  switch (kind) {
    case 'start-planning':
      return 'Task planning could not be started.';
    case 'accept-plan':
      return 'Task Plan could not be accepted.';
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
    case 'push-branch':
      return 'Task branch could not be pushed.';
    case 'create-pull-request':
      return 'Pull Request could not be created or refreshed.';
  }
}

function refreshFailureMessage(kind: WorkspaceActionKind): string {
  switch (kind) {
    case 'start-planning':
      return 'Task planning started, but workspace status could not be refreshed.';
    case 'accept-plan':
      return 'Task Plan accepted, but workspace status could not be refreshed.';
    case 'start-execution':
    case 'retry-execution':
      return 'Task execution started, but workspace status could not be refreshed.';
    case 'request-review':
      return 'Task review requested, but workspace status could not be refreshed.';
    case 'approve-review':
      return 'Task review approved, but workspace status could not be refreshed.';
    case 'request-changes':
      return 'Task changes requested, but workspace status could not be refreshed.';
    case 'push-branch':
      return 'Task branch pushed, but workspace status could not be refreshed.';
    case 'create-pull-request':
      return 'Pull Request updated, but workspace status could not be refreshed.';
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

function sameFileChange(left: TaskFileChange, right: TaskFileChange): boolean {
  return (
    left.area === right.area &&
    left.kind === right.kind &&
    left.path === right.path &&
    left.previousPath === right.previousPath
  );
}
