import { describe, expect, it } from 'vitest';

import { createDesktopBridge, DesktopBridgeError, type DesktopIpcRenderer } from './desktop-bridge';
import { desktopIpcChannels, terminalIpcEventChannel } from './ipc-contract';

class FakeIpcRenderer implements DesktopIpcRenderer {
  public readonly calls: Array<{ channel: string; input: unknown }> = [];
  public readonly listeners = new Map<string, (...arguments_: unknown[]) => void>();
  public response: (channel: string, input: unknown) => unknown = () => ({
    ok: true,
    value: null,
  });

  public async invoke(channel: string, input: unknown): Promise<unknown> {
    this.calls.push({ channel, input });
    return this.response(channel, input);
  }

  public on(channel: string, listener: (...arguments_: unknown[]) => void): void {
    this.listeners.set(channel, listener);
  }

  public removeListener(channel: string, listener: (...arguments_: unknown[]) => void): void {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  public emit(channel: string, payload: unknown): void {
    this.listeners.get(channel)?.({}, payload);
  }
}

describe('desktop preload bridge', () => {
  it('exposes only the typed AgentTerm capability allowlist', () => {
    const lifecycle = createDesktopBridge(new FakeIpcRenderer(), () => 'sub-1');

    expect(Object.keys(lifecycle.api).sort()).toEqual([
      'acceptTaskPlan',
      'approveTaskReview',
      'attachTerminal',
      'createTaskPullRequest',
      'getTaskFileDiff',
      'inspectTaskPullRequest',
      'listQualityGates',
      'listTaskChanges',
      'loadSettings',
      'loadWorkspace',
      'pushTaskBranch',
      'refreshTaskPullRequest',
      'requestTaskChanges',
      'requestTaskReview',
      'retryTaskExecution',
      'runQualityGate',
      'startTaskExecution',
      'startTaskPlanning',
      'updateSettings',
    ]);
    expect(lifecycle.api).not.toHaveProperty('invoke');
    expect(lifecycle.api).not.toHaveProperty('ipcRenderer');
    expect(lifecycle.api).not.toHaveProperty('require');
  });

  it('maps structured handler errors without exposing arbitrary rejection details', async () => {
    const ipc = new FakeIpcRenderer();
    ipc.response = () => ({
      error: { code: 'INVALID_REQUEST', message: 'The desktop request is invalid.' },
      ok: false,
    });
    const { api } = createDesktopBridge(ipc, () => 'sub-1');

    await expect(api.startTaskExecution({ agentId: 'codex', taskId: 'task-1' })).rejects.toEqual(
      new DesktopBridgeError('INVALID_REQUEST', 'The desktop request is invalid.'),
    );
  });

  it('registers terminal ownership before attach, routes events, and unsubscribes idempotently', async () => {
    const ipc = new FakeIpcRenderer();
    const events: unknown[] = [];
    ipc.response = (channel, input) => {
      if (channel === desktopIpcChannels.terminalAttach) {
        ipc.emit(terminalIpcEventChannel, {
          event: { kind: 'started', sequence: 1 },
          subscriptionId: (input as { subscriptionId: string }).subscriptionId,
        });
      }
      return { ok: true, value: null };
    };
    const lifecycle = createDesktopBridge(ipc, () => 'd14a72b9-26f6-4a9c-a810-69935ec6d277');

    const attachment = await lifecycle.api.attachTerminal({
      eventSink: (event) => events.push(event),
      sessionId: 'session-1',
    });
    expect(events).toEqual([{ kind: 'started', sequence: 1 }]);

    await attachment.write('status\r');
    await attachment.resize({ columns: 100, rows: 30 });
    attachment.detach();
    attachment.detach();
    ipc.emit(terminalIpcEventChannel, {
      event: { data: 'late', kind: 'output', sequence: 2 },
      subscriptionId: 'd14a72b9-26f6-4a9c-a810-69935ec6d277',
    });

    expect(events).toHaveLength(1);
    expect(ipc.calls.map(({ channel }) => channel)).toEqual([
      desktopIpcChannels.terminalAttach,
      desktopIpcChannels.terminalWrite,
      desktopIpcChannels.terminalResize,
      desktopIpcChannels.terminalDetach,
    ]);

    lifecycle.dispose();
    expect(ipc.listeners.has(terminalIpcEventChannel)).toBe(false);
  });
});
