import type { AgentWorkspaceOverview } from '@agentterm/application';

import type { TerminalSessionClient } from './terminal-controller';

export interface AgentWorkspaceClient extends TerminalSessionClient {
  loadWorkspace(): Promise<AgentWorkspaceOverview>;
  startTaskExecution(input: { readonly taskId: string }): Promise<void>;
}

export type WorkspaceSnapshot =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly actionError: string | undefined;
      readonly kind: 'ready';
      readonly overview: AgentWorkspaceOverview;
      readonly selectedTaskId: string | undefined;
      readonly startingTaskId: string | undefined;
      readonly terminalSessionId: string | undefined;
    };

export class WorkspaceController {
  private disposed = false;
  private loadGeneration = 0;
  private readonly client: AgentWorkspaceClient;
  private readonly sink: ((snapshot: WorkspaceSnapshot) => void) | undefined;
  private startAttempt: Promise<void> | undefined;
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

  public startSelectedTask(): Promise<void> {
    if (this.startAttempt !== undefined) {
      return this.startAttempt;
    }
    if (this.snapshot.kind !== 'ready' || this.snapshot.selectedTaskId === undefined) {
      return Promise.resolve();
    }

    const taskId = this.snapshot.selectedTaskId;
    const attempt = this.startTask(taskId);
    this.startAttempt = attempt;
    void attempt
      .finally(() => {
        if (this.startAttempt === attempt) {
          this.startAttempt = undefined;
        }
      })
      .catch(() => undefined);
    return attempt;
  }

  public dispose(): void {
    this.disposed = true;
    this.loadGeneration += 1;
  }

  private async startTask(taskId: string): Promise<void> {
    const current = this.snapshot;
    if (current.kind !== 'ready') {
      return;
    }
    let executionStarted = false;
    this.publish(
      Object.freeze({
        ...current,
        actionError: undefined,
        startingTaskId: taskId,
      }),
    );
    try {
      await this.client.startTaskExecution({ taskId });
      executionStarted = true;
      const overview = await this.client.loadWorkspace();
      if (!this.disposed) {
        const preferredTaskId =
          this.snapshot.kind === 'ready' ? this.snapshot.selectedTaskId : taskId;
        this.publishReady(overview, preferredTaskId);
      }
    } catch {
      if (!this.disposed) {
        const latest = this.snapshot.kind === 'ready' ? this.snapshot : current;
        this.publish(
          Object.freeze({
            ...latest,
            actionError: executionStarted
              ? 'Task execution started, but workspace status could not be refreshed.'
              : 'Task execution could not be started.',
            selectedTaskId: latest.selectedTaskId ?? taskId,
            startingTaskId: undefined,
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
    const previousTerminalSessionId =
      this.snapshot.kind === 'ready' && this.snapshot.selectedTaskId === selectedTaskId
        ? this.snapshot.terminalSessionId
        : undefined;
    this.publish(
      Object.freeze({
        actionError: undefined,
        kind: 'ready',
        overview,
        selectedTaskId,
        startingTaskId: undefined,
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
