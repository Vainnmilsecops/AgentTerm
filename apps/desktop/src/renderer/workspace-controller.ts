import type {
  AgentWorkspaceOverview,
  ApplicationSettingsView,
  ExecutionArtifact,
  QualityGate,
  TaskChangeSet,
  TaskFileChange,
  TaskFileDiff,
  TaskPullRequestState,
  UpdateApplicationSettingsInput,
  WorkspaceLayoutRecord,
} from '@agentterm/application';

import type { AgentTermDesktopApi } from '../ipc-contract';
import {
  activateWorkspacePane,
  activateWorkspaceTab,
  closeWorkspacePane,
  closeWorkspaceTab,
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

export type AgentWorkspaceClient = AgentTermDesktopApi;

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
  | 'add-dependency'
  | 'approve-review'
  | 'begin-planning'
  | 'create-pull-request'
  | 'produce-artifact'
  | 'push-branch'
  | 'refresh-pull-request'
  | 'remove-dependency'
  | 'request-changes'
  | 'request-review'
  | 'retry-execution'
  | 'run-quality-gate'
  | 'start-execution'
  | 'start-planning';

type SelectedWorkspaceActionKind = Exclude<
  WorkspaceActionKind,
  'add-dependency' | 'produce-artifact' | 'remove-dependency'
>;

export type WorkspaceAction =
  | {
      readonly dependencyTaskId: string;
      readonly kind: 'add-dependency' | 'remove-dependency';
      readonly taskId: string;
    }
  | {
      readonly content: string;
      readonly createdAt: number;
      readonly id: string;
      readonly artifactKind: ExecutionArtifact['kind'];
      readonly kind: 'produce-artifact';
      readonly sessionId: string | undefined;
      readonly taskId: string;
    }
  | {
      readonly gateId: string;
      readonly kind: 'run-quality-gate';
      readonly taskId: string;
    }
  | {
      readonly kind: 'refresh-pull-request';
      readonly pullRequestNumber: number;
      readonly repositoryName: string;
      readonly repositoryOwner: string;
      readonly taskId: string;
    }
  | {
      readonly kind: Exclude<
        WorkspaceActionKind,
        | 'add-dependency'
        | 'produce-artifact'
        | 'refresh-pull-request'
        | 'remove-dependency'
        | 'run-quality-gate'
      >;
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
      readonly layoutPersistenceError?: string | undefined;
      readonly onboardingBusy?: boolean;
      readonly overview: AgentWorkspaceOverview;
      readonly qualityGates?: readonly QualityGate[];
      readonly pullRequestInspection?: WorkspacePullRequestInspection;
      readonly selectedAgentId: string | undefined;
      readonly settings?: ApplicationSettingsView;
      readonly settingsError?: string | undefined;
      readonly settingsSaving?: boolean;
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
  private onboardingAttempt: Promise<boolean> | undefined;
  private settingsAttempt: Promise<void> | undefined;
  private layoutRevision = 0;
  private layoutSaveAttempt: Promise<void> | undefined;
  private layoutSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private layoutSaveQueued = false;
  public snapshot: WorkspaceSnapshot = Object.freeze({ kind: 'loading' });

  public constructor(client: AgentWorkspaceClient, sink?: (snapshot: WorkspaceSnapshot) => void) {
    this.client = client;
    this.sink = sink;
  }

  public async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.publish(Object.freeze({ kind: 'loading' }));
    try {
      const [overview, qualityGates, settings, persistedLayout] = await Promise.all([
        this.client.loadWorkspace(),
        this.client.listQualityGateDetails(),
        this.client.loadSettings(),
        this.client.loadWorkspaceLayout(),
      ]);
      if (this.disposed || generation !== this.loadGeneration) {
        return;
      }
      if (persistedLayout !== undefined) {
        this.layoutRevision = persistedLayout.revision;
      } else {
        this.layoutRevision = 0;
      }
      this.publishReady(overview, qualityGates, undefined, settings, persistedLayout?.layout);
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
      const [overview, qualityGates, settings, persistedLayout] = await Promise.all([
        this.client.loadWorkspace(),
        this.client.listQualityGateDetails(),
        this.client.loadSettings(),
        this.client.loadWorkspaceLayout(),
      ]);
      if (!this.disposed && generation === this.loadGeneration) {
        if (persistedLayout !== undefined && persistedLayout.revision > this.layoutRevision) {
          this.layoutRevision = persistedLayout.revision;
        }
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : requestedTaskId;
        this.publishReady(overview, qualityGates, preferredTaskId, settings, undefined);
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
    this.schedulePersistLayout(layout);
    void this.loadSelectedTaskEvidence();
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

  public openProject(): Promise<boolean> {
    if (this.onboardingAttempt !== undefined) return this.onboardingAttempt;
    if (this.snapshot.kind !== 'ready') return Promise.resolve(false);
    const current = this.snapshot;
    this.publish(Object.freeze({ ...current, actionError: undefined, onboardingBusy: true }));
    const attempt = this.client
      .openProject()
      .then(async (result) => {
        if (result === 'CANCELLED') {
          if (!this.disposed && this.snapshot.kind === 'ready') {
            this.publish(Object.freeze({ ...this.snapshot, onboardingBusy: false }));
          }
          return false;
        }
        await this.reloadAfterOnboarding(undefined);
        return true;
      })
      .catch(() => {
        if (!this.disposed && this.snapshot.kind === 'ready') {
          this.publish(
            Object.freeze({
              ...this.snapshot,
              actionError: 'Project could not be opened. Select a local Git repository.',
              onboardingBusy: false,
            }),
          );
        }
        return false;
      })
      .finally(() => {
        if (this.onboardingAttempt === attempt) this.onboardingAttempt = undefined;
      });
    this.onboardingAttempt = attempt;
    return attempt;
  }

  public createTask(input: {
    readonly brief: string;
    readonly projectId: string;
    readonly title: string;
  }): Promise<boolean> {
    if (this.onboardingAttempt !== undefined) return this.onboardingAttempt;
    if (
      this.snapshot.kind !== 'ready' ||
      !this.snapshot.overview.projects.some(({ project }) => project.id === input.projectId) ||
      input.title.trim().length === 0 ||
      input.brief.trim().length === 0
    ) {
      return Promise.resolve(false);
    }
    const current = this.snapshot;
    this.publish(Object.freeze({ ...current, actionError: undefined, onboardingBusy: true }));
    const attempt = this.client
      .createTask({
        brief: input.brief.trim(),
        projectId: input.projectId,
        title: input.title.trim(),
      })
      .then(async ({ taskId }) => {
        await this.reloadAfterOnboarding(taskId);
        return true;
      })
      .catch(() => {
        if (!this.disposed && this.snapshot.kind === 'ready') {
          this.publish(
            Object.freeze({
              ...this.snapshot,
              actionError: 'Task could not be created. Check the title and selected Project.',
              onboardingBusy: false,
            }),
          );
        }
        return false;
      })
      .finally(() => {
        if (this.onboardingAttempt === attempt) this.onboardingAttempt = undefined;
      });
    this.onboardingAttempt = attempt;
    return attempt;
  }

  public saveSettings(input: UpdateApplicationSettingsInput): Promise<void> {
    if (this.settingsAttempt !== undefined) {
      return this.settingsAttempt;
    }
    if (this.snapshot.kind !== 'ready') {
      return Promise.resolve();
    }
    const current = this.snapshot;
    this.publish(Object.freeze({ ...current, settingsError: undefined, settingsSaving: true }));
    const attempt = this.client
      .updateSettings(input)
      .then((settings) => {
        if (this.disposed || this.snapshot.kind !== 'ready') {
          return;
        }
        this.publish(
          Object.freeze({
            ...this.snapshot,
            selectedAgentId: selectAvailableAgentId(
              this.snapshot.overview,
              settings.settings.defaultAgentId,
            ),
            settings,
            settingsError: undefined,
            settingsSaving: false,
          }),
        );
      })
      .catch(() => {
        if (!this.disposed && this.snapshot.kind === 'ready') {
          this.publish(
            Object.freeze({
              ...this.snapshot,
              settingsError: 'Settings could not be saved. Check the agent configuration.',
              settingsSaving: false,
            }),
          );
        }
      })
      .finally(() => {
        if (this.settingsAttempt === attempt) {
          this.settingsAttempt = undefined;
        }
      });
    this.settingsAttempt = attempt;
    return attempt;
  }

  public startSelectedTask(): Promise<void> {
    return this.executeSelectedAction('start-execution');
  }

  public beginSelectedTaskPlanning(): Promise<void> {
    return this.executeSelectedAction('begin-planning');
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

  public refreshSelectedTaskPullRequest(): Promise<void> {
    return this.executeSelectedAction('refresh-pull-request');
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

  public static canProduceArtifact(
    phase: AgentWorkspaceOverview['projects'][number]['tasks'][number]['task']['phase'],
  ): boolean {
    return phase !== 'DONE';
  }

  public static canEditDependencies(
    phase: AgentWorkspaceOverview['projects'][number]['tasks'][number]['task']['phase'],
  ): boolean {
    return phase !== 'DONE';
  }

  public getSelectedTask():
    | AgentWorkspaceOverview['projects'][number]['tasks'][number]
    | undefined {
    if (this.snapshot.kind !== 'ready') return undefined;
    return findTask(this.snapshot.overview, this.snapshot.selectedTaskId);
  }

  public getTaskDependencies():
    | AgentWorkspaceOverview['projects'][number]['tasks'][number]['dependencies']
    | undefined {
    const selected = this.getSelectedTask();
    return selected?.dependencies;
  }

  public async registerQualityGate(input: {
    readonly arguments: readonly string[];
    readonly executablePath: string;
    readonly id: string;
    readonly kind: QualityGate['kind'];
    readonly timeoutMs: number;
  }): Promise<QualityGate> {
    await this.client.registerQualityGate({
      command: {
        arguments: input.arguments,
        executablePath: input.executablePath,
      },
      id: input.id,
      kind: input.kind,
      timeoutMs: input.timeoutMs,
    });
    await this.refreshQualityGateCatalog();
    const persisted =
      this.snapshot.kind === 'ready'
        ? this.snapshot.qualityGates?.find((gate) => gate.id === input.id)
        : undefined;
    return (
      persisted ??
      Object.freeze({
        command: Object.freeze({
          arguments: Object.freeze([...input.arguments]),
          executablePath: input.executablePath,
        }),
        id: input.id,
        kind: input.kind,
        timeoutMs: input.timeoutMs,
      })
    );
  }

  public async unregisterQualityGate(gateId: string): Promise<boolean> {
    const removed = await this.client.unregisterQualityGate({ gateId });
    await this.refreshQualityGateCatalog();
    return removed;
  }

  private async refreshQualityGateCatalog(): Promise<void> {
    if (this.snapshot.kind !== 'ready') return;
    try {
      const gates = await this.client.listQualityGateDetails();
      this.publish({
        ...this.snapshot,
        qualityGates: Object.freeze([...gates]),
      });
    } catch {
      // Surface via existing error path; keep previous snapshot.
    }
  }

  public produceArtifact(input: {
    readonly content: string;
    readonly createdAt: number;
    readonly id: string;
    readonly kind: ExecutionArtifact['kind'];
    readonly sessionId: string | undefined;
    readonly taskId: string;
  }): Promise<ExecutionArtifact> {
    if (this.snapshot.kind !== 'ready' || !containsTask(this.snapshot.overview, input.taskId)) {
      return Promise.reject(new Error('The selected Task is no longer available.'));
    }
    if (this.actionAttempt !== undefined) {
      return Promise.reject(new Error('Another workspace action is already running.'));
    }
    const action = Object.freeze({
      artifactKind: input.kind,
      content: input.content,
      createdAt: input.createdAt,
      id: input.id,
      kind: 'produce-artifact' as const,
      sessionId: input.sessionId,
      taskId: input.taskId,
    });
    const attempt = this.performArtifactAction(action);
    const actionAttempt = attempt.then(() => undefined);
    this.actionAttempt = actionAttempt;
    void actionAttempt
      .finally(() => {
        if (this.actionAttempt === actionAttempt) this.actionAttempt = undefined;
      })
      .catch(() => undefined);
    return attempt;
  }

  public addTaskDependency(input: {
    readonly dependencyTaskId: string;
    readonly taskId: string;
  }): Promise<void> {
    if (this.snapshot.kind !== 'ready' || !containsTask(this.snapshot.overview, input.taskId)) {
      return Promise.resolve();
    }
    return this.executeAction({
      dependencyTaskId: input.dependencyTaskId,
      kind: 'add-dependency',
      taskId: input.taskId,
    });
  }

  public removeTaskDependency(input: {
    readonly dependencyTaskId: string;
    readonly taskId: string;
  }): Promise<void> {
    if (this.snapshot.kind !== 'ready' || !containsTask(this.snapshot.overview, input.taskId)) {
      return Promise.resolve();
    }
    return this.executeAction({
      dependencyTaskId: input.dependencyTaskId,
      kind: 'remove-dependency',
      taskId: input.taskId,
    });
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

  private executeSelectedAction(kind: SelectedWorkspaceActionKind, gateId?: string): Promise<void> {
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
        : kind === 'refresh-pull-request'
          ? createPullRequestRefreshAction(taskId, this.snapshot.pullRequestInspection)
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

  private async performArtifactAction(
    action: Extract<WorkspaceAction, { readonly kind: 'produce-artifact' }>,
  ): Promise<ExecutionArtifact> {
    const current = this.snapshot;
    if (current.kind !== 'ready') {
      throw new Error('The workspace is not ready.');
    }
    this.publish(
      Object.freeze({
        ...current,
        actionError: undefined,
        activeAction: action,
      }),
    );

    let artifact: ExecutionArtifact;
    try {
      artifact = await this.client.createArtifact({
        content: action.content,
        createdAt: action.createdAt,
        id: action.id,
        kind: action.artifactKind,
        ...(action.sessionId === undefined ? {} : { sessionId: action.sessionId }),
        taskId: action.taskId,
      });
    } catch {
      if (!this.disposed) {
        const latest = this.snapshot.kind === 'ready' ? this.snapshot : current;
        this.publish(
          Object.freeze({
            ...latest,
            actionError: 'Artifact could not be persisted. Check the content format.',
            activeAction: undefined,
          }),
        );
      }
      throw new Error('Artifact could not be persisted. Check the content format.');
    }

    try {
      const [overview, qualityGates] = await Promise.all([
        this.client.loadWorkspace(),
        this.client.listQualityGateDetails(),
      ]);
      if (!this.disposed) {
        const latestSettings =
          this.snapshot.kind === 'ready' ? this.snapshot.settings : current.settings;
        this.publishReady(overview, qualityGates, action.taskId, latestSettings, undefined);
        await this.loadSelectedTaskEvidence();
      }
    } catch {
      if (!this.disposed) {
        const latest = this.snapshot.kind === 'ready' ? this.snapshot : current;
        this.publish(
          Object.freeze({
            ...latest,
            actionError: 'Artifact persisted, but workspace status could not be refreshed.',
            activeAction: undefined,
          }),
        );
      }
    }
    return artifact;
  }

  private executeAction(action: WorkspaceAction): Promise<void> {
    if (this.actionAttempt !== undefined) {
      return this.actionAttempt;
    }
    const attempt = (async (): Promise<void> => {
      const current = this.snapshot;
      if (current.kind !== 'ready') return;
      let sideEffectCompleted = false;
      this.publish(
        Object.freeze({
          ...current,
          actionError: undefined,
          activeAction: Object.freeze(action),
        }),
      );
      try {
        await runWorkspaceAction(this.client, action, undefined, undefined);
        sideEffectCompleted = true;
        await this.refresh();
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
    })();
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
    if (this.layoutSaveTimer !== undefined) {
      clearTimeout(this.layoutSaveTimer);
      this.layoutSaveTimer = undefined;
    }
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
        this.client.listQualityGateDetails(),
      ]);
      if (!this.disposed) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : action.taskId;
        const latestSettings =
          this.snapshot.kind === 'ready' ? this.snapshot.settings : current.settings;
        this.publishReady(overview, qualityGates, preferredTaskId, latestSettings, undefined);
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

  private async reloadAfterOnboarding(preferredTaskId: string | undefined): Promise<void> {
    const [overview, qualityGates, settings, persistedLayout] = await Promise.all([
      this.client.loadWorkspace(),
      this.client.listQualityGateDetails(),
      this.client.loadSettings(),
      this.client.loadWorkspaceLayout(),
    ]);
    if (this.disposed) return;
    if (persistedLayout !== undefined) {
      this.layoutRevision = persistedLayout.revision;
    }
    this.publishReady(overview, qualityGates, preferredTaskId, settings, persistedLayout?.layout);
    await this.loadSelectedTaskEvidence();
  }

  private publishReady(
    overview: AgentWorkspaceOverview,
    qualityGates: readonly QualityGate[],
    preferredTaskId: string | undefined,
    settings: ApplicationSettingsView | undefined,
    persistedLayout: WorkspaceLayoutRecord | undefined,
  ): void {
    const currentSettings = this.snapshot.kind === 'ready' ? this.snapshot.settings : undefined;
    const effectiveSettings =
      currentSettings !== undefined &&
      (settings === undefined || currentSettings.settings.revision > settings.settings.revision)
        ? currentSettings
        : settings;
    const preferredAvailableTaskId = selectAvailableTaskId(overview, preferredTaskId);
    const preferredAgentId =
      this.snapshot.kind === 'ready'
        ? this.snapshot.selectedAgentId
        : effectiveSettings?.settings.defaultAgentId;
    const selectedAgentId = selectAvailableAgentId(overview, preferredAgentId);
    const reconciledFromPersisted =
      persistedLayout !== undefined ? hydrateWorkspaceLayout(persistedLayout) : undefined;
    let layout =
      this.snapshot.kind === 'ready'
        ? reconcileWorkspaceLayout(this.snapshot.layout, workspaceTaskSessionContexts(overview))
        : reconciledFromPersisted;
    if (layout === undefined) {
      layout = Object.freeze({ activeTabId: undefined, tabs: Object.freeze([]) });
    }
    if (preferredAvailableTaskId !== undefined) {
      const preferredTask = findTask(overview, preferredAvailableTaskId);
      layout = openWorkspaceTab(
        layout,
        {
          taskId: preferredAvailableTaskId,
          ...(preferredTask?.activeSession?.id === undefined
            ? {}
            : { sessionId: preferredTask.activeSession.id }),
        },
      );
    }
    layout = reconcileWorkspaceLayout(layout, workspaceTaskSessionContexts(overview));
    if (layout.tabs.length === 0) {
      layout = Object.freeze({ activeTabId: undefined, tabs: Object.freeze([]) });
    }
    const selectedTaskId = findActiveWorkspaceTab(layout)?.taskId;
    this.publish(
      Object.freeze({
        actionError: undefined,
        activeAction: undefined,
        changeInspection: Object.freeze({ kind: 'idle' }),
        kind: 'ready',
        layout,
        onboardingBusy: false,
        overview,
        pullRequestInspection: Object.freeze({ kind: 'idle' }),
        qualityGates: Object.freeze([...qualityGates]),
        selectedAgentId,
        ...(effectiveSettings === undefined ? {} : { settings: effectiveSettings }),
        settingsError: undefined,
        settingsSaving: false,
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
    this.schedulePersistLayout(layout);
    if (taskChanged) {
      void this.loadSelectedTaskEvidence();
    }
  }

  private schedulePersistLayout(layout: WorkspaceLayout): void {
    this.layoutSaveQueued = true;
    if (this.layoutSaveTimer !== undefined) {
      clearTimeout(this.layoutSaveTimer);
    }
    this.layoutSaveTimer = setTimeout(() => {
      this.layoutSaveTimer = undefined;
      void this.persistLayout(layout);
    }, 250);
  }

  private async persistLayout(layout: WorkspaceLayout): Promise<void> {
    const expectedRevision = this.layoutRevision;
    const attempt = this.layoutSaveAttempt ?? Promise.resolve();
    const next = attempt
      .catch(() => undefined)
      .then(() => this.runPersistLayout(layout, expectedRevision));
    this.layoutSaveAttempt = next;
    await next.catch(() => undefined);
    if (this.layoutSaveAttempt === next) {
      this.layoutSaveAttempt = undefined;
    }
  }

  private async runPersistLayout(layout: WorkspaceLayout, expectedRevision: number): Promise<void> {
    if (!this.layoutSaveQueued) return;
    this.layoutSaveQueued = false;
    const serialized = serializeWorkspaceLayout(layout);
    if (serialized === undefined) {
      this.layoutSaveQueued = true;
      return;
    }
    try {
      const result = await this.client.saveWorkspaceLayout({
        expectedRevision,
        layout: serialized,
      });
      if (this.disposed) return;
      this.layoutRevision = result.revision;
      if (this.snapshot.kind === 'ready' && this.snapshot.layoutPersistenceError !== undefined) {
        this.publish(
          Object.freeze({
            ...this.snapshot,
            layoutPersistenceError: undefined,
          }),
        );
      }
    } catch (error) {
      if (this.disposed) return;
      const message =
        error instanceof Error ? error.message : 'Workspace layout could not be persisted.';
      if (this.snapshot.kind === 'ready') {
        this.publish(
          Object.freeze({
            ...this.snapshot,
            layoutPersistenceError: message,
          }),
        );
      }
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
    case 'begin-planning':
      await client.beginTaskPlanning({ taskId: action.taskId });
      return;
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
    case 'produce-artifact':
      await client.createArtifact({
        content: action.content,
        createdAt: action.createdAt,
        id: action.id,
        kind: action.artifactKind,
        ...(action.sessionId === undefined ? {} : { sessionId: action.sessionId }),
        taskId: action.taskId,
      });
      return;
    case 'add-dependency':
      await client.addTaskDependency({
        dependencyTaskId: action.dependencyTaskId,
        taskId: action.taskId,
      });
      return;
    case 'remove-dependency':
      await client.removeTaskDependency({
        dependencyTaskId: action.dependencyTaskId,
        taskId: action.taskId,
      });
      return;
    case 'refresh-pull-request':
      await client.refreshTaskPullRequest({
        pullRequestNumber: action.pullRequestNumber,
        repositoryName: action.repositoryName,
        repositoryOwner: action.repositoryOwner,
        taskId: action.taskId,
      });
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
    case 'begin-planning':
      return task.canBeginPlanning;
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
    case 'produce-artifact':
      return true;
    case 'add-dependency':
    case 'remove-dependency':
      return true;
    case 'refresh-pull-request':
      return (
        pullRequestInspection?.kind === 'ready' &&
        pullRequestInspection.result.pullRequest !== undefined
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

function createPullRequestRefreshAction(
  taskId: string,
  inspection: WorkspacePullRequestInspection | undefined,
): Extract<WorkspaceAction, { readonly kind: 'refresh-pull-request' }> {
  if (inspection?.kind !== 'ready' || inspection.result.pullRequest === undefined) {
    throw new TypeError('A persisted Pull Request is required.');
  }
  return {
    kind: 'refresh-pull-request',
    pullRequestNumber: inspection.result.pullRequest.number,
    repositoryName: inspection.result.pullRequest.repositoryName,
    repositoryOwner: inspection.result.pullRequest.repositoryOwner,
    taskId,
  };
}

function actionFailureMessage(kind: WorkspaceActionKind): string {
  switch (kind) {
    case 'begin-planning':
      return 'Task could not enter planning.';
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
      return 'Pull Request could not be created.';
    case 'refresh-pull-request':
      return 'Pull Request status could not be refreshed from GitHub.';
    case 'produce-artifact':
      return 'Artifact could not be persisted. Check the content format.';
    case 'add-dependency':
      return 'Task dependency could not be added.';
    case 'remove-dependency':
      return 'Task dependency could not be removed.';
  }
}

function refreshFailureMessage(kind: WorkspaceActionKind): string {
  switch (kind) {
    case 'begin-planning':
      return 'Task entered planning, but workspace status could not be refreshed.';
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
    case 'refresh-pull-request':
      return 'Pull Request refreshed, but workspace status could not be reloaded.';
    case 'produce-artifact':
      return 'Artifact persisted, but workspace status could not be refreshed.';
    case 'add-dependency':
      return 'Task dependency added, but workspace status could not be refreshed.';
    case 'remove-dependency':
      return 'Task dependency removed, but workspace status could not be refreshed.';
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

function serializeWorkspaceLayout(layout: WorkspaceLayout): WorkspaceLayoutRecord | undefined {
  try {
    return JSON.parse(JSON.stringify(layout)) as WorkspaceLayoutRecord;
  } catch {
    return undefined;
  }
}

function hydrateWorkspaceLayout(record: WorkspaceLayoutRecord): WorkspaceLayout {
  return Object.freeze({
    activeTabId: record.activeTabId,
    tabs: Object.freeze(
      record.tabs.map((tab) =>
        Object.freeze({
          activePaneId: tab.activePaneId,
          id: tab.id,
          panes: Object.freeze(
            tab.panes.map((pane) =>
              Object.freeze({
                id: pane.id,
                sessionId: pane.sessionId,
                taskId: pane.taskId,
              }),
            ),
          ),
          taskId: tab.taskId,
        }),
      ),
    ),
  });
}
