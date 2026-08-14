import type { AgentSessionTerminalAttachment, PtyRuntimeEvent } from '@agentterm/application';

import {
  DesktopIpcRequestValidationError,
  desktopIpcChannels,
  terminalIpcEventChannel,
  validateDesktopIpcRequest,
  type AgentTermDesktopApi,
  type DesktopIpcChannel,
  type DesktopIpcError,
  type DesktopIpcErrorCode,
  type DesktopIpcRequestMap,
  type DesktopIpcResponse,
  type OpenDesktopProjectResult,
} from './ipc-contract';

export type DesktopIpcApplication = Omit<AgentTermDesktopApi, 'openProject'> & {
  openProject(input: { readonly path: string }): Promise<void>;
};

export interface DesktopIpcSender {
  readonly id: number;
  isDestroyed(): boolean;
  on(event: 'destroyed', listener: () => void): this;
  once(event: 'destroyed', listener: () => void): this;
  removeListener(event: 'destroyed', listener: () => void): this;
  send(channel: string, payload: unknown): void;
}

export interface DesktopIpcMainEvent {
  readonly frameId: number;
  readonly sender: DesktopIpcSender;
  readonly senderFrame: unknown | null;
}

export interface DesktopIpcMain {
  handle(channel: string, listener: (event: DesktopIpcMainEvent, input: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

interface RegisteredTerminalAttachment {
  readonly attachment: AgentSessionTerminalAttachment;
  readonly senderId: number;
  readonly subscriptionId: string;
}

interface RegisterDesktopIpcHandlersInput {
  readonly application: DesktopIpcApplication | Promise<DesktopIpcApplication>;
  readonly authorize: (event: DesktopIpcMainEvent) => boolean;
  readonly ipcMain: DesktopIpcMain;
  readonly selectProjectDirectory: () => Promise<string | undefined>;
}

class DesktopIpcHandlerError extends Error {
  public constructor(public readonly code: DesktopIpcErrorCode) {
    super(code);
    this.name = 'DesktopIpcHandlerError';
  }
}

const conflictErrors = new Set([
  'AgentSessionActiveConflictError',
  'AgentSessionTerminalAttachmentConflictError',
  'ApplicationSettingsConflictError',
  'EntityAlreadyExistsError',
  'TaskWorktreeMetadataConflictError',
]);
const notFoundErrors = new Set(['AgentSessionRuntimeOwnershipError', 'EntityNotFoundError']);
const unavailableErrors = new Set(['AgentNotConfiguredError']);
const expectedApplicationErrors = new Set([
  'AgentAdapterError',
  'AgentSessionPersistenceError',
  'AgentSessionRuntimeOwnershipError',
  'ApplicationSettingsValidationError',
  'ArtifactProvenanceError',
  'GitRepositoryInspectionError',
  'ProjectOpenError',
  'PtyRuntimeError',
  'QualityGateExecutionError',
  'QualityGatePersistenceError',
  'QualityGateProcessUnsettledError',
  'SqlitePersistenceError',
  'TaskChangeInspectionError',
  'TaskDependencyBlockedError',
  'TaskDependencyProjectMismatchError',
  'TaskExecutionPhaseError',
  'TaskExecutionRetryError',
  'TaskExecutionStartError',
  'InvalidTaskPhaseTransitionError',
  'TaskPlanningPhaseError',
  'TaskPlanReadinessError',
  'TaskPullRequestError',
  'TaskReviewReadinessError',
  'TaskWorktreeLifecycleError',
  'TaskWorktreePersistenceError',
]);

export function registerDesktopIpcHandlers(input: RegisterDesktopIpcHandlersInput): () => void {
  const attachments = new Map<string, RegisteredTerminalAttachment>();
  const senderCleanup = new Map<
    number,
    { readonly listener: () => void; readonly sender: DesktopIpcSender }
  >();
  let disposed = false;

  const attachmentKey = (senderId: number, subscriptionId: string): string =>
    `${String(senderId)}:${subscriptionId}`;

  const detachRegistration = (registration: RegisteredTerminalAttachment): void => {
    const key = attachmentKey(registration.senderId, registration.subscriptionId);
    if (attachments.get(key) !== registration) return;
    attachments.delete(key);
    try {
      registration.attachment.detach();
    } catch {
      // Detach is cleanup-only and must not alter the Agent Session lifecycle.
    }
  };

  const cleanupSender = (senderId: number): void => {
    for (const registration of [...attachments.values()]) {
      if (registration.senderId === senderId) detachRegistration(registration);
    }
    const cleanup = senderCleanup.get(senderId);
    if (cleanup !== undefined) {
      cleanup.sender.removeListener('destroyed', cleanup.listener);
      senderCleanup.delete(senderId);
    }
  };

  const ownSender = (sender: DesktopIpcSender): void => {
    if (senderCleanup.has(sender.id)) return;
    const listener = (): void => cleanupSender(sender.id);
    senderCleanup.set(sender.id, { listener, sender });
    sender.once('destroyed', listener);
  };

  const requireAttachment = (
    senderId: number,
    subscriptionId: string,
  ): RegisteredTerminalAttachment => {
    const registration = attachments.get(attachmentKey(senderId, subscriptionId));
    if (registration === undefined) throw new DesktopIpcHandlerError('NOT_FOUND');
    return registration;
  };

  const dispatch = async <C extends DesktopIpcChannel>(
    channel: C,
    request: DesktopIpcRequestMap[C],
    event: DesktopIpcMainEvent,
  ): Promise<unknown> => {
    const application = await input.application;
    switch (channel) {
      case desktopIpcChannels.loadWorkspace:
        return application.loadWorkspace();
      case desktopIpcChannels.openProject: {
        const path = await input.selectProjectDirectory();
        if (path === undefined) return 'CANCELLED' satisfies OpenDesktopProjectResult;
        await application.openProject({ path });
        return 'OPENED' satisfies OpenDesktopProjectResult;
      }
      case desktopIpcChannels.createTask:
        return application.createTask(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.createTask],
        );
      case desktopIpcChannels.beginTaskPlanning:
        await application.beginTaskPlanning(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.beginTaskPlanning],
        );
        return null;
      case desktopIpcChannels.loadSettings:
        return application.loadSettings();
      case desktopIpcChannels.updateSettings:
        return application.updateSettings(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.updateSettings],
        );
      case desktopIpcChannels.listQualityGateDetails:
        return application.listQualityGateDetails();
      case desktopIpcChannels.listQualityGates:
        return application.listQualityGates();
      case desktopIpcChannels.startPlanning:
        await application.startTaskPlanning(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.startPlanning],
        );
        return null;
      case desktopIpcChannels.acceptPlan:
        await application.acceptTaskPlan(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.acceptPlan],
        );
        return null;
      case desktopIpcChannels.startExecution:
        await application.startTaskExecution(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.startExecution],
        );
        return null;
      case desktopIpcChannels.retryExecution:
        await application.retryTaskExecution(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.retryExecution],
        );
        return null;
      case desktopIpcChannels.requestReview:
        await application.requestTaskReview(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.requestReview],
        );
        return null;
      case desktopIpcChannels.approveReview:
        await application.approveTaskReview(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.approveReview],
        );
        return null;
      case desktopIpcChannels.requestChanges:
        await application.requestTaskChanges(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.requestChanges],
        );
        return null;
      case desktopIpcChannels.runQualityGate:
        await application.runQualityGate(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.runQualityGate],
        );
        return null;
      case desktopIpcChannels.listTaskChanges:
        return application.listTaskChanges(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.listTaskChanges],
        );
      case desktopIpcChannels.getTaskFileDiff:
        return application.getTaskFileDiff(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.getTaskFileDiff],
        );
      case desktopIpcChannels.inspectPullRequest:
        return application.inspectTaskPullRequest(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.inspectPullRequest],
        );
      case desktopIpcChannels.pushTaskBranch:
        await application.pushTaskBranch(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.pushTaskBranch],
        );
        return null;
      case desktopIpcChannels.createPullRequest:
        await application.createTaskPullRequest(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.createPullRequest],
        );
        return null;
      case desktopIpcChannels.refreshPullRequest:
        await application.refreshTaskPullRequest(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.refreshPullRequest],
        );
        return null;
      case desktopIpcChannels.registerQualityGate:
        await application.registerQualityGate(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.registerQualityGate],
        );
        return null;
      case desktopIpcChannels.unregisterQualityGate:
        return application.unregisterQualityGate(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.unregisterQualityGate],
        );
      case desktopIpcChannels.createArtifact:
        return application.createArtifact(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.createArtifact],
        );
      case desktopIpcChannels.listTaskDependencies:
        return application.listTaskDependencies(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.listTaskDependencies],
        );
      case desktopIpcChannels.listProjectTasks:
        return application.listProjectTasks(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.listProjectTasks],
        );
      case desktopIpcChannels.listTaskReviews:
        return application.listTaskReviews(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.listTaskReviews],
        );
      case desktopIpcChannels.addTaskDependency:
        return application.addTaskDependency(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.addTaskDependency],
        );
      case desktopIpcChannels.removeTaskDependency:
        return application.removeTaskDependency(
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.removeTaskDependency],
        );
      case desktopIpcChannels.terminalAttach: {
        const terminalRequest =
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.terminalAttach];
        const key = attachmentKey(event.sender.id, terminalRequest.subscriptionId);
        if (attachments.has(key)) throw new DesktopIpcHandlerError('CONFLICT');
        ownSender(event.sender);
        const attachment = await application.attachTerminal({
          eventSink: (runtimeEvent: PtyRuntimeEvent): void => {
            if (event.sender.isDestroyed()) return;
            try {
              event.sender.send(terminalIpcEventChannel, {
                event: runtimeEvent,
                subscriptionId: terminalRequest.subscriptionId,
              });
            } catch {
              // A renderer delivery failure cannot interrupt runtime/session evidence handling.
            }
          },
          sessionId: terminalRequest.sessionId,
        });
        if (event.sender.isDestroyed() || disposed) {
          attachment.detach();
          throw new DesktopIpcHandlerError('UNAVAILABLE');
        }
        attachments.set(key, {
          attachment,
          senderId: event.sender.id,
          subscriptionId: terminalRequest.subscriptionId,
        });
        return null;
      }
      case desktopIpcChannels.terminalWrite: {
        const terminalRequest =
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.terminalWrite];
        await requireAttachment(event.sender.id, terminalRequest.subscriptionId).attachment.write(
          terminalRequest.data,
        );
        return null;
      }
      case desktopIpcChannels.terminalResize: {
        const terminalRequest =
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.terminalResize];
        await requireAttachment(event.sender.id, terminalRequest.subscriptionId).attachment.resize({
          columns: terminalRequest.columns,
          rows: terminalRequest.rows,
        });
        return null;
      }
      case desktopIpcChannels.terminalDetach: {
        const terminalRequest =
          request as DesktopIpcRequestMap[typeof desktopIpcChannels.terminalDetach];
        const registration = attachments.get(
          attachmentKey(event.sender.id, terminalRequest.subscriptionId),
        );
        if (registration !== undefined) detachRegistration(registration);
        return null;
      }
    }
  };

  for (const channel of Object.values(desktopIpcChannels)) {
    input.ipcMain.handle(channel, async (event, rawRequest) => {
      try {
        if (disposed || !input.authorize(event)) {
          throw new DesktopIpcHandlerError('UNAUTHORIZED');
        }
        const request = validateDesktopIpcRequest(channel, rawRequest);
        const value = await dispatch(channel, request, event);
        return { ok: true, value } satisfies DesktopIpcResponse<unknown>;
      } catch (error) {
        return { error: mapDesktopIpcError(error), ok: false } satisfies DesktopIpcResponse<never>;
      }
    });
  }

  return (): void => {
    if (disposed) return;
    disposed = true;
    for (const channel of Object.values(desktopIpcChannels)) input.ipcMain.removeHandler(channel);
    for (const registration of [...attachments.values()]) detachRegistration(registration);
    for (const { listener, sender } of senderCleanup.values()) {
      sender.removeListener('destroyed', listener);
    }
    senderCleanup.clear();
  };
}

function mapDesktopIpcError(error: unknown): DesktopIpcError {
  if (error instanceof DesktopIpcRequestValidationError) {
    return Object.freeze({ code: 'INVALID_REQUEST', message: 'The desktop request is invalid.' });
  }
  if (error instanceof DesktopIpcHandlerError) {
    return Object.freeze(errorForCode(error.code));
  }
  const name = error instanceof Error ? error.name : undefined;
  if (name !== undefined && conflictErrors.has(name))
    return Object.freeze(errorForCode('CONFLICT'));
  if (name !== undefined && notFoundErrors.has(name))
    return Object.freeze(errorForCode('NOT_FOUND'));
  if (name !== undefined && unavailableErrors.has(name))
    return Object.freeze(errorForCode('UNAVAILABLE'));
  if (name !== undefined && expectedApplicationErrors.has(name)) {
    return Object.freeze(errorForCode('OPERATION_FAILED'));
  }
  return Object.freeze(errorForCode('INTERNAL_ERROR'));
}

function errorForCode(code: DesktopIpcErrorCode): DesktopIpcError {
  switch (code) {
    case 'INVALID_REQUEST':
      return { code, message: 'The desktop request is invalid.' };
    case 'UNAUTHORIZED':
      return { code, message: 'The desktop request is not authorized.' };
    case 'NOT_FOUND':
      return { code, message: 'The requested desktop resource was not found.' };
    case 'CONFLICT':
      return { code, message: 'The desktop operation conflicts with current state.' };
    case 'UNAVAILABLE':
      return { code, message: 'The desktop capability is not available.' };
    case 'OPERATION_FAILED':
      return { code, message: 'The requested AgentTerm operation failed.' };
    case 'INTERNAL_ERROR':
      return { code, message: 'The desktop operation could not be completed.' };
  }
}
