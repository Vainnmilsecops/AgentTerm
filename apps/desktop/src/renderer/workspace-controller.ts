import type {
  AgentWorkspaceOverview,
  GetTaskFileDiffInput,
  QualityGateSummary,
  TaskChangeSet,
  TaskFileChange,
  TaskFileDiff,
  TaskPullRequestState,
} from '@agentterm/application';

import type { TerminalSessionClient } from './terminal-controller';
import {
  activateWorkspacePane,
  activateWorkspaceTab,
  closeWorkspacePane,
  closeWorkspaceTab,
  createWorkspaceLayout,
  cycleWorkspacePane,
  cycleWorkspaceTab,
  findActiveWorkspacePane,
  findActiveWorkspaceTab,
  openWorkspaceTab,
  reconcileWorkspaceLayout,
  splitWorkspaceTerminal,
  WorkspaceLayoutError,
  type WorkspaceLayout,
} from './workspace-layout';

export interface AgentWorkspaceClient extends TerminalSessionClient {
  acceptTaskPlan(input: { readonly planId: string; readonly taskId: string }): Promise<void>;
  approveTaskReview(input: { readonly reviewId: string; readonly taskId: string }): Promise<void>;
  getTaskFileDiff(input: GetTaskFileDiffInput): Promise<TaskFileDiff>;
  createTaskPullRequest(input: { readonly taskId: string }): Promise<void>;
  inspectTaskPullRequest(input: { readonly taskId: string }): Promise<TaskPullRequestState>;
  listTaskChanges(input: { readonly taskId: string }): Promise<TaskChangeSet>;
  listQualityGates(): Promise<readonly QualityGateSummary[]>;
  loadWorkspace(): Promise<AgentWorkspaceOverview>;
  requestTaskChanges(input: { readonly reviewId: string; readonly taskId: string }): Promise<void>;
  requestTaskReview(input: { readonly taskId: string }): Promise<void>;
  pushTaskBranch(input: { readonly taskId: string }): Promise<void>;
  retryTaskExecution(input: { readonly agentId: string; readonly taskId: string }): Promise<void>;
  runQualityGate(input: { readonly gateId: string; readonly taskId: string }): Promise<void>;
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
  | 'run-quality-gate'
  | 'start-execution'
  | 'start-planning';

export type WorkspaceAction =
  | {
      readonly gateId: string;
      readonly kind: 'run-quality-gate';
      readonly taskId: string;
    }
  | {
      readonly kind: Exclude<WorkspaceActionKind, 'run-quality-gate'>;
      readonly taskId: string;
    };

export type WorkspaceSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly actionError: string | undefined;
      readonly activeAction: WorkspaceAction | undefined;
      readonly changeInspection?: WorkspaceChangeInspection;
      readonly kind: 'ready';
      readonly layout: WorkspaceLayout;
      readonly overview: AgentWorkspaceOverview;
      readonly qualityGates?: readonly QualityGateSummary[];
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
      const [overview, qualityGates] = await Promise.all([
        this.client.loadWorkspace(),
        this.client.listQualityGates(),
      ]);
      if (this.disposed || generation !== this.loadGeneration) {
        return;
      }
      this.publishReady(overview, qualityGates, undefined);
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
      const [overview, qualityGates] = await Promise.all([
        this.client.loadWorkspace(),
        this.client.listQualityGates(),
      ]);
      if (!this.disposed && generation === this.loadGeneration) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : requestedTaskId;
        this.publishReady(overview, qualityGates, preferredTaskId);
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
    const layout = openTaskWorkspaceTab(
      this.snapshot.layout,
      taskId,
      selectedTask?.activeSession?.id,
    );
    this.publish(
      Object.freeze({
        ...this.snapshot,
        actionError: undefined,
        changeInspection: Object.freeze({ kind: 'idle' }),
        pullRequestInspection: Object.freeze({ kind: 'idle' }),
        layout,
        selectedTaskId: taskId,
        terminalSessionId: findActiveWorkspacePane(layout)?.sessionId,
      }),
    );
    void this.loadSelectedTaskChanges();
  }

  public selectWorkspaceTab(tabId: string): void {
    this.publishWorkspaceLayout(activateWorkspaceTab(this.requireLayout(), tabId), true);
  }

  public closeWorkspaceTab(tabId: string): void {
    this.publishWorkspaceLayout(closeWorkspaceTab(this.requireLayout(), tabId), true);
  }

  public cycleWorkspaceTab(delta: -1 | 1): void {
    this.publishWorkspaceLayout(cycleWorkspaceTab(this.requireLayout(), delta), true);
  }

  public splitSelectedTerminal(sessionId: string): void {
    if (this.snapshot.kind !== 'ready') {
      return;
    }
    const task = findTaskByActiveSession(this.snapshot.overview, sessionId);
    if (task === undefined) {
      return;
    }
    try {
      this.publishWorkspaceLayout(
        splitWorkspaceTerminal(this.snapshot.layout, { sessionId, taskId: task.task.id }),
        false,
      );
    } catch (error) {
      if (!(error instanceof WorkspaceLayoutError)) {
        throw error;
      }
    }
  }

  public selectWorkspacePane(paneId: string): void {
    this.publishWorkspaceLayout(activateWorkspacePane(this.requireLayout(), paneId), false);
  }

  public closeWorkspacePane(paneId: string): void {
    this.publishWorkspaceLayout(closeWorkspacePane(this.requireLayout(), paneId), false);
  }

  public cycleWorkspacePane(delta: -1 | 1): void {
    this.publishWorkspaceLayout(cycleWorkspacePane(this.requireLayout(), delta), false);
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

  public runSelectedQualityGate(gateId: string): Promise<void> {
    if (
      this.snapshot.kind !== 'ready' ||
      this.snapshot.qualityGates?.some((gate) => gate.id === gateId) !== true
    ) {
      return Promise.resolve();
    }
    return this.executeSelectedAction('run-quality-gate', gateId);
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

  private executeSelectedAction(kind: WorkspaceActionKind, gateId?: string): Promise<void> {
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

    const action: WorkspaceAction =
      kind === 'run-quality-gate'
        ? { gateId: requireGateId(gateId), kind, taskId }
        : { kind, taskId };
    const attempt = this.performAction(action, evidenceId, selectedAgentId);
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
      const [overview, qualityGates] = await Promise.all([
        this.client.loadWorkspace(),
        this.client.listQualityGates(),
      ]);
      if (!this.disposed) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : action.taskId;
        this.publishReady(overview, qualityGates, preferredTaskId);
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
    qualityGates: readonly QualityGateSummary[],
    preferredTaskId: string | undefined,
  ): void {
    const preferredAvailableTaskId = selectAvailableTaskId(overview, preferredTaskId);
    const preferredAgentId =
      this.snapshot.kind === 'ready' ? this.snapshot.selectedAgentId : undefined;
    const selectedAgentId = selectAvailableAgentId(overview, preferredAgentId);
    let layout =
      this.snapshot.kind === 'ready'
        ? reconcileWorkspaceLayout(this.snapshot.layout, workspaceTaskSessionContexts(overview))
        : undefined;
    if (preferredAvailableTaskId !== undefined) {
      const preferredTask = findTask(overview, preferredAvailableTaskId);
      layout = openWorkspaceTab(
        layout ??
          createWorkspaceLayout({
            taskId: preferredAvailableTaskId,
            ...(preferredTask?.activeSession?.id === undefined
              ? {}
              : { sessionId: preferredTask.activeSession.id }),
          }),
        {
          taskId: preferredAvailableTaskId,
          ...(preferredTask?.activeSession?.id === undefined
            ? {}
            : { sessionId: preferredTask.activeSession.id }),
        },
      );
    }
    layout ??= Object.freeze({ activeTabId: undefined, tabs: Object.freeze([]) });
    const selectedTaskId = findActiveWorkspaceTab(layout)?.taskId;
    this.publish(
      Object.freeze({
        actionError: undefined,
        activeAction: undefined,
        changeInspection: Object.freeze({ kind: 'idle' }),
        kind: 'ready',
        layout,
        overview,
        pullRequestInspection: Object.freeze({ kind: 'idle' }),
        qualityGates: Object.freeze([...qualityGates]),
        selectedAgentId,
        selectedTaskId,
        terminalSessionId: findActiveWorkspacePane(layout)?.sessionId,
      }),
    );
  }

  private requireLayout(): WorkspaceLayout {
    return this.snapshot.kind === 'ready'
      ? this.snapshot.layout
      : Object.freeze({ activeTabId: undefined, tabs: Object.freeze([]) });
  }

  private publishWorkspaceLayout(layout: WorkspaceLayout, taskMayChange: boolean): void {
    const current = this.snapshot;
    if (current.kind !== 'ready' || layout === current.layout) {
      return;
    }
    const selectedTaskId = findActiveWorkspaceTab(layout)?.taskId;
    const taskChanged = taskMayChange && selectedTaskId !== current.selectedTaskId;
    this.publish(
      Object.freeze({
        ...current,
        actionError: undefined,
        ...(taskChanged
          ? {
              changeInspection: Object.freeze({ kind: 'idle' } as const),
              pullRequestInspection: Object.freeze({ kind: 'idle' } as const),
            }
          : {}),
        layout,
        selectedTaskId,
        terminalSessionId: findActiveWorkspacePane(layout)?.sessionId,
      }),
    );
    if (taskChanged) {
      void this.loadSelectedTaskEvidence();
    }
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
    case 'run-quality-gate':
      await client.runQualityGate({ gateId: action.gateId, taskId: action.taskId });
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
    case 'run-quality-gate':
      return task.canRunQualityGate;
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

function requireGateId(gateId: string | undefined): string {
  if (gateId === undefined) {
    throw new TypeError('A configured Quality Gate is required.');
  }
  return gateId;
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
    case 'run-quality-gate':
      return 'Quality Gate could not be run.';
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
    case 'run-quality-gate':
      return 'Quality Gate completed, but workspace status could not be refreshed.';
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

function findTaskByActiveSession(
  overview: AgentWorkspaceOverview,
  sessionId: string,
): AgentWorkspaceOverview['projects'][number]['tasks'][number] | undefined {
  return overview.projects
    .flatMap((project) => project.tasks)
    .find((task) => task.activeSession?.id === sessionId);
}

function workspaceTaskSessionContexts(overview: AgentWorkspaceOverview) {
  return overview.projects.flatMap((project) =>
    project.tasks.map((task) => ({
      activeSessionId: task.activeSession?.id,
      taskId: task.task.id,
    })),
  );
}

function openTaskWorkspaceTab(
  layout: WorkspaceLayout,
  taskId: string,
  sessionId: string | undefined,
): WorkspaceLayout {
  try {
    return openWorkspaceTab(layout, {
      taskId,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  } catch (error) {
    if (!(error instanceof WorkspaceLayoutError) || error.reason !== 'SESSION_ALREADY_ATTACHED') {
      throw error;
    }
    return openWorkspaceTab(layout, { taskId });
  }
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
