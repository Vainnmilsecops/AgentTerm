import type { PtyRuntimeEvent, PtyTerminalSize } from '@agentterm/application';

import {
  desktopIpcChannels,
  terminalIpcEventChannel,
  validateDesktopIpcRequest,
  validateTerminalIpcEventMessage,
  type AgentTermDesktopApi,
  type DesktopIpcChannel,
  type DesktopIpcErrorCode,
  type DesktopIpcRequestMap,
  type DesktopIpcResponse,
  type DesktopIpcResponseMap,
} from './ipc-contract';

export interface DesktopIpcRenderer {
  invoke(channel: string, input: unknown): Promise<unknown>;
  on(channel: string, listener: (...arguments_: unknown[]) => void): void;
  removeListener(channel: string, listener: (...arguments_: unknown[]) => void): void;
}

export interface DesktopBridgeLifecycle {
  readonly api: AgentTermDesktopApi;
  dispose(): void;
}

export class DesktopBridgeError extends Error {
  public constructor(
    public readonly code: DesktopIpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DesktopBridgeError';
  }
}

const knownErrorCodes = new Set<DesktopIpcErrorCode>([
  'CONFLICT',
  'INTERNAL_ERROR',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'OPERATION_FAILED',
  'UNAUTHORIZED',
  'UNAVAILABLE',
]);

export function createDesktopBridge(
  ipcRenderer: DesktopIpcRenderer,
  createSubscriptionId: () => string = () => globalThis.crypto.randomUUID(),
): DesktopBridgeLifecycle {
  const terminalSinks = new Map<string, (event: PtyRuntimeEvent) => void>();
  let disposed = false;
  const onTerminalEvent = (...arguments_: unknown[]): void => {
    if (disposed) return;
    try {
      const message = validateTerminalIpcEventMessage(arguments_[1]);
      terminalSinks.get(message.subscriptionId)?.(message.event);
    } catch {
      // Invalid main-process events never reach terminal consumers.
    }
  };
  ipcRenderer.on(terminalIpcEventChannel, onTerminalEvent);

  const invoke = async <C extends DesktopIpcChannel>(
    channel: C,
    input: DesktopIpcRequestMap[C],
  ): Promise<DesktopIpcResponseMap[C]> => {
    if (disposed) {
      throw new DesktopBridgeError('UNAVAILABLE', 'The desktop connection is not available.');
    }
    const validated = validateDesktopIpcRequest(channel, input);
    let response: unknown;
    try {
      response = await ipcRenderer.invoke(channel, validated);
    } catch {
      throw new DesktopBridgeError(
        'INTERNAL_ERROR',
        'The desktop operation could not be completed.',
      );
    }
    return unwrapResponse<DesktopIpcResponseMap[C]>(response);
  };

  const invokeVoid = async <C extends DesktopIpcChannel>(
    channel: C,
    input: DesktopIpcRequestMap[C],
  ): Promise<void> => {
    await invoke(channel, input);
  };

  const api: AgentTermDesktopApi = {
    acceptTaskPlan: (input) => invokeVoid(desktopIpcChannels.acceptPlan, input),
    addTaskDependency: (input) => invoke(desktopIpcChannels.addTaskDependency, input),
    approveTaskReview: (input) => invokeVoid(desktopIpcChannels.approveReview, input),
    attachTerminal: async ({ eventSink, sessionId }) => {
      if (typeof eventSink !== 'function') {
        throw new DesktopBridgeError('INVALID_REQUEST', 'The desktop request is invalid.');
      }
      const subscriptionId = createSubscriptionId();
      validateDesktopIpcRequest(desktopIpcChannels.terminalAttach, {
        sessionId,
        subscriptionId,
      });
      if (terminalSinks.has(subscriptionId)) {
        throw new DesktopBridgeError('CONFLICT', 'The terminal subscription already exists.');
      }
      terminalSinks.set(subscriptionId, eventSink);
      try {
        await invoke(desktopIpcChannels.terminalAttach, { sessionId, subscriptionId });
      } catch (error) {
        terminalSinks.delete(subscriptionId);
        throw error;
      }
      let attached = true;
      const requireAttached = (): void => {
        if (!attached || disposed || terminalSinks.get(subscriptionId) !== eventSink) {
          throw new DesktopBridgeError('NOT_FOUND', 'The terminal subscription is not active.');
        }
      };
      return Object.freeze({
        detach: (): void => {
          if (!attached) return;
          attached = false;
          terminalSinks.delete(subscriptionId);
          void invokeVoid(desktopIpcChannels.terminalDetach, { subscriptionId }).catch(
            () => undefined,
          );
        },
        resize: async (size: PtyTerminalSize): Promise<void> => {
          requireAttached();
          await invokeVoid(desktopIpcChannels.terminalResize, { ...size, subscriptionId });
        },
        write: async (data: string): Promise<void> => {
          requireAttached();
          await invokeVoid(desktopIpcChannels.terminalWrite, { data, subscriptionId });
        },
      });
    },
    beginTaskPlanning: (input) => invokeVoid(desktopIpcChannels.beginTaskPlanning, input),
    createArtifact: (input) => invoke(desktopIpcChannels.createArtifact, input),
    createTask: (input) => invoke(desktopIpcChannels.createTask, input),
    createTaskPullRequest: (input) => invokeVoid(desktopIpcChannels.createPullRequest, input),
    getTaskFileDiff: (input) => invoke(desktopIpcChannels.getTaskFileDiff, input),
    importQualityGateConfig: (input) => invoke(desktopIpcChannels.importQualityGateConfig, input),
    inspectTaskPullRequest: (input) => invoke(desktopIpcChannels.inspectPullRequest, input),
    listProjectTasks: (input) => invoke(desktopIpcChannels.listProjectTasks, input),
    listQualityGateDetails: () => invoke(desktopIpcChannels.listQualityGateDetails, {}),
    listQualityGates: () => invoke(desktopIpcChannels.listQualityGates, {}),
    listTaskChanges: (input) => invoke(desktopIpcChannels.listTaskChanges, input),
    listTaskDependencies: (input) => invoke(desktopIpcChannels.listTaskDependencies, input),
    listTaskReviews: (input) => invoke(desktopIpcChannels.listTaskReviews, input),
    loadQualityGateConfig: (input) => invoke(desktopIpcChannels.loadQualityGateConfig, input),
    loadSettings: () => invoke(desktopIpcChannels.loadSettings, {}),
    loadWorkspace: () => invoke(desktopIpcChannels.loadWorkspace, {}),
    loadWorkspaceLayout: () => invoke(desktopIpcChannels.loadWorkspaceLayout, {}),
    openBoardWindow: () => invokeVoid(desktopIpcChannels.openBoardWindow, {}),
    openProject: () => invoke(desktopIpcChannels.openProject, {}),
    pushTaskBranch: (input) => invokeVoid(desktopIpcChannels.pushTaskBranch, input),
    refreshTaskPullRequest: (input) => invokeVoid(desktopIpcChannels.refreshPullRequest, input),
    registerQualityGate: (input) => invokeVoid(desktopIpcChannels.registerQualityGate, input),
    removeTaskDependency: (input) => invoke(desktopIpcChannels.removeTaskDependency, input),
    requestTaskChanges: (input) => invokeVoid(desktopIpcChannels.requestChanges, input),
    requestTaskReview: (input) => invokeVoid(desktopIpcChannels.requestReview, input),
    retryTaskExecution: (input) => invokeVoid(desktopIpcChannels.retryExecution, input),
    runQualityGate: (input) => invokeVoid(desktopIpcChannels.runQualityGate, input),
    stopAgentSession: (input) => invokeVoid(desktopIpcChannels.stopAgentSession, input),
    saveQualityGateConfig: (input) => invoke(desktopIpcChannels.saveQualityGateConfig, input),
    saveWorkspaceLayout: (input) => invoke(desktopIpcChannels.saveWorkspaceLayout, input),
    selectQualityGateConfigPath: () => invoke(desktopIpcChannels.selectQualityGateConfigPath, {}),
    startTaskExecution: (input) => invokeVoid(desktopIpcChannels.startExecution, input),
    startTaskPlanning: (input) => invokeVoid(desktopIpcChannels.startPlanning, input),
    unregisterQualityGate: (input) => invoke(desktopIpcChannels.unregisterQualityGate, input),
    updateSettings: (input) => invoke(desktopIpcChannels.updateSettings, input),
  };
  Object.freeze(api);

  return Object.freeze({
    api,
    dispose(): void {
      if (disposed) return;
      for (const subscriptionId of terminalSinks.keys()) {
        void ipcRenderer
          .invoke(desktopIpcChannels.terminalDetach, { subscriptionId })
          .catch(() => undefined);
      }
      terminalSinks.clear();
      disposed = true;
      ipcRenderer.removeListener(terminalIpcEventChannel, onTerminalEvent);
    },
  });
}

function unwrapResponse<T>(input: unknown): T {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DesktopBridgeError('INTERNAL_ERROR', 'The desktop response is invalid.');
  }
  const response = input as Partial<DesktopIpcResponse<T>>;
  if (response.ok === true && Object.hasOwn(response, 'value')) {
    return response.value as T;
  }
  if (
    response.ok === false &&
    typeof response.error === 'object' &&
    response.error !== null &&
    typeof response.error.code === 'string' &&
    knownErrorCodes.has(response.error.code as DesktopIpcErrorCode) &&
    typeof response.error.message === 'string' &&
    response.error.message.length <= 512
  ) {
    throw new DesktopBridgeError(
      response.error.code as DesktopIpcErrorCode,
      response.error.message,
    );
  }
  throw new DesktopBridgeError('INTERNAL_ERROR', 'The desktop response is invalid.');
}
