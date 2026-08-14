import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { AgentWorkspaceOverview, PtyRuntimeEvent } from '@agentterm/application';

import {
  registerDesktopIpcHandlers,
  type DesktopIpcApplication,
  type DesktopIpcMain,
  type DesktopIpcMainEvent,
  type DesktopIpcSender,
} from './desktop-main-handlers';
import { desktopIpcChannels, terminalIpcEventChannel } from './ipc-contract';

const emptyWorkspace: AgentWorkspaceOverview = Object.freeze({ agents: [], projects: [] });

class FakeIpcMain implements DesktopIpcMain {
  public readonly handlers = new Map<
    string,
    (event: DesktopIpcMainEvent, input: unknown) => unknown
  >();

  public handle(
    channel: string,
    listener: (event: DesktopIpcMainEvent, input: unknown) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  public invoke(channel: string, event: DesktopIpcMainEvent, input: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`Missing handler: ${channel}`);
    return Promise.resolve(handler(event, input));
  }
}

class FakeSender extends EventEmitter implements DesktopIpcSender {
  public readonly send = vi.fn();
  public destroyed = false;

  public constructor(public readonly id: number) {
    super();
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public destroy(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

describe('desktop main IPC handlers', () => {
  it('rejects an unauthorized sender before invoking Application behavior', async () => {
    const ipcMain = new FakeIpcMain();
    const application = createApplication();
    const dispose = registerDesktopIpcHandlers({
      application,
      authorize: () => false,
      ipcMain,
      selectProjectDirectory: async () => undefined,
    });
    const sender = new FakeSender(7);

    await expect(
      ipcMain.invoke(desktopIpcChannels.loadWorkspace, event(sender), {}),
    ).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'The desktop request is not authorized.' },
      ok: false,
    });
    expect(application.loadWorkspace).not.toHaveBeenCalled();

    dispose();
    expect(ipcMain.handlers.size).toBe(0);
  });

  it('validates payloads before dispatch and maps handler failures without leaking secrets', async () => {
    const ipcMain = new FakeIpcMain();
    const application = createApplication({
      startTaskExecution: vi.fn(async () => {
        throw new Error('GH_TOKEN=secret C:\\private\\repo');
      }),
    });
    registerDesktopIpcHandlers({
      application,
      authorize: () => true,
      ipcMain,
      selectProjectDirectory: async () => undefined,
    });
    const sender = new FakeSender(3);

    await expect(
      ipcMain.invoke(desktopIpcChannels.startExecution, event(sender), {
        agentId: 'codex',
        taskId: '',
      }),
    ).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' }, ok: false });
    expect(application.startTaskExecution).not.toHaveBeenCalled();

    const failure = await ipcMain.invoke(desktopIpcChannels.startExecution, event(sender), {
      agentId: 'codex',
      taskId: 'task-1',
    });
    expect(failure).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'The desktop operation could not be completed.' },
      ok: false,
    });
    expect(JSON.stringify(failure)).not.toMatch(/secret|private|GH_TOKEN/iu);
  });

  it('returns typed successful responses from the explicit handler allowlist', async () => {
    const ipcMain = new FakeIpcMain();
    const application = createApplication();
    registerDesktopIpcHandlers({
      application,
      authorize: () => true,
      ipcMain,
      selectProjectDirectory: async () => undefined,
    });

    await expect(
      ipcMain.invoke(desktopIpcChannels.loadWorkspace, event(new FakeSender(1)), {}),
    ).resolves.toEqual({ ok: true, value: emptyWorkspace });
    expect([...ipcMain.handlers.keys()].sort()).toEqual(Object.values(desktopIpcChannels).sort());
  });

  it('keeps native Project selection in main and handles an explicit cancel', async () => {
    const ipcMain = new FakeIpcMain();
    const application = createApplication({ openProject: vi.fn(async () => undefined) });
    const selectedPaths: Array<string | undefined> = ['D:\\Core\\AgentTerm', undefined];
    const selectProjectDirectory = vi.fn(async () => selectedPaths.shift());
    registerDesktopIpcHandlers({
      application,
      authorize: () => true,
      ipcMain,
      selectProjectDirectory,
    });
    const sender = new FakeSender(5);

    const opened = await ipcMain.invoke(desktopIpcChannels.openProject, event(sender), {});
    const cancelled = await ipcMain.invoke(desktopIpcChannels.openProject, event(sender), {});

    expect(opened).toEqual({ ok: true, value: 'OPENED' });
    expect(cancelled).toEqual({ ok: true, value: 'CANCELLED' });
    expect(application.openProject).toHaveBeenCalledOnce();
    expect(application.openProject).toHaveBeenCalledWith({ path: 'D:\\Core\\AgentTerm' });
    expect(JSON.stringify([opened, cancelled])).not.toContain('D:\\Core');
  });

  it('dispatches validated Task creation and the fixed BACKLOG to PLANNING action', async () => {
    const ipcMain = new FakeIpcMain();
    const application = createApplication({
      beginTaskPlanning: vi.fn(async () => undefined),
      createTask: vi.fn(async () => ({ taskId: 'task-created' })),
    });
    registerDesktopIpcHandlers({
      application,
      authorize: () => true,
      ipcMain,
      selectProjectDirectory: async () => undefined,
    });
    const sender = new FakeSender(6);

    await expect(
      ipcMain.invoke(desktopIpcChannels.createTask, event(sender), {
        projectId: 'project-1',
        title: 'Tạo Task',
      }),
    ).resolves.toEqual({ ok: true, value: { taskId: 'task-created' } });
    await expect(
      ipcMain.invoke(desktopIpcChannels.beginTaskPlanning, event(sender), {
        taskId: 'task-created',
      }),
    ).resolves.toEqual({ ok: true, value: null });

    expect(application.createTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'Tạo Task',
    });
    expect(application.beginTaskPlanning).toHaveBeenCalledWith({ taskId: 'task-created' });
  });

  it('owns terminal subscriptions per sender and detaches without terminating the Session', async () => {
    const ipcMain = new FakeIpcMain();
    let eventSink: ((event: PtyRuntimeEvent) => void) | undefined;
    const attachment = {
      detach: vi.fn(),
      resize: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
    };
    const application = createApplication({
      attachTerminal: vi.fn(async (input) => {
        eventSink = input.eventSink;
        return attachment;
      }),
    });
    registerDesktopIpcHandlers({
      application,
      authorize: () => true,
      ipcMain,
      selectProjectDirectory: async () => undefined,
    });
    const owner = new FakeSender(11);
    const other = new FakeSender(12);
    const subscriptionId = 'd14a72b9-26f6-4a9c-a810-69935ec6d277';

    await expect(
      ipcMain.invoke(desktopIpcChannels.terminalAttach, event(owner), {
        sessionId: 'session-1',
        subscriptionId,
      }),
    ).resolves.toEqual({ ok: true, value: null });
    eventSink?.({ data: 'Xin chào', kind: 'output', sequence: 1 });
    expect(owner.send).toHaveBeenCalledWith(terminalIpcEventChannel, {
      event: { data: 'Xin chào', kind: 'output', sequence: 1 },
      subscriptionId,
    });

    await ipcMain.invoke(desktopIpcChannels.terminalWrite, event(owner), {
      data: 'help\r',
      subscriptionId,
    });
    await ipcMain.invoke(desktopIpcChannels.terminalResize, event(owner), {
      columns: 120,
      rows: 40,
      subscriptionId,
    });
    expect(attachment.write).toHaveBeenCalledWith('help\r');
    expect(attachment.resize).toHaveBeenCalledWith({ columns: 120, rows: 40 });

    await expect(
      ipcMain.invoke(desktopIpcChannels.terminalWrite, event(other), {
        data: 'unauthorized',
        subscriptionId,
      }),
    ).resolves.toMatchObject({ error: { code: 'NOT_FOUND' }, ok: false });

    owner.destroy();
    expect(attachment.detach).toHaveBeenCalledOnce();
    expect(attachment).not.toHaveProperty('terminate');
  });
});

function event(sender: FakeSender): DesktopIpcMainEvent {
  return { frameId: 1, sender, senderFrame: Object.freeze({}) };
}

function createApplication(
  overrides: Partial<DesktopIpcApplication> = {},
): DesktopIpcApplication & Record<string, ReturnType<typeof vi.fn>> {
  const unavailable = async (): Promise<never> => {
    throw new Error('Unexpected fake application call.');
  };
  return {
    acceptTaskPlan: vi.fn(unavailable),
    approveTaskReview: vi.fn(unavailable),
    attachTerminal: vi.fn(unavailable),
    beginTaskPlanning: vi.fn(unavailable),
    createTask: vi.fn(unavailable),
    createTaskPullRequest: vi.fn(unavailable),
    getTaskFileDiff: vi.fn(unavailable),
    inspectTaskPullRequest: vi.fn(unavailable),
    listQualityGates: vi.fn(unavailable),
    listTaskChanges: vi.fn(unavailable),
    loadSettings: vi.fn(unavailable),
    loadWorkspace: vi.fn(async () => emptyWorkspace),
    openProject: vi.fn(unavailable),
    pushTaskBranch: vi.fn(unavailable),
    refreshTaskPullRequest: vi.fn(unavailable),
    requestTaskChanges: vi.fn(unavailable),
    requestTaskReview: vi.fn(unavailable),
    retryTaskExecution: vi.fn(unavailable),
    runQualityGate: vi.fn(unavailable),
    startTaskExecution: vi.fn(unavailable),
    startTaskPlanning: vi.fn(unavailable),
    updateSettings: vi.fn(unavailable),
    ...overrides,
  } as DesktopIpcApplication & Record<string, ReturnType<typeof vi.fn>>;
}
