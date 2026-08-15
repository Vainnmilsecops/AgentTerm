import { describe, expect, it } from 'vitest';

import {
  DesktopIpcRequestValidationError,
  desktopIpcChannels,
  validateDesktopIpcRequest,
  validateTerminalIpcEventMessage,
} from './ipc-contract';

describe('desktop IPC contract validation', () => {
  it('accepts one exact allowlisted execution request', () => {
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.startExecution, {
        agentId: 'claude',
        taskId: 'task-1',
      }),
    ).toEqual({ agentId: 'claude', taskId: 'task-1' });
  });

  it('accepts a Quality Gate configuration load request with a bounded path', () => {
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.loadQualityGateConfig, {
        path: 'C:/agentterm/quality-gates.json',
      }),
    ).toEqual({ path: 'C:/agentterm/quality-gates.json' });
  });

  it('accepts a Quality Gate configuration save request with a minimal gate payload', () => {
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.saveQualityGateConfig, {
        configuration: {
          gates: [
            {
              command: { arguments: ['lint'], executablePath: 'C:/node/node.exe' },
              id: 'lint:eslint',
              kind: 'LINT',
              timeoutMs: 60_000,
            },
          ],
          revision: 'rev-1',
        },
        path: 'C:/agentterm/quality-gates.json',
      }),
    ).toEqual({
      configuration: {
        gates: [
          {
            command: { arguments: ['lint'], executablePath: 'C:/node/node.exe' },
            id: 'lint:eslint',
            kind: 'LINT',
            timeoutMs: 60_000,
          },
        ],
        revision: 'rev-1',
      },
      path: 'C:/agentterm/quality-gates.json',
    });
  });

  it.each([
    [desktopIpcChannels.loadQualityGateConfig, { path: '' }],
    [
      desktopIpcChannels.saveQualityGateConfig,
      {
        configuration: { gates: [], revision: '   ' },
        path: 'C:/agentterm/quality-gates.json',
      },
    ],
    [
      desktopIpcChannels.saveQualityGateConfig,
      {
        configuration: {
          gates: [
            {
              command: { arguments: ['lint'], executablePath: 'relative' },
              id: 'lint:eslint',
              kind: 'LINT',
              timeoutMs: 60_000,
            },
          ],
          revision: 'rev-1',
        },
        path: 'C:/agentterm/quality-gates.json',
      },
    ],
    [
      desktopIpcChannels.saveQualityGateConfig,
      {
        configuration: {
          gates: [
            {
              command: { arguments: ['lint'], executablePath: 'C:/node/node.exe' },
              id: 'lint:eslint',
              kind: 'LINT',
              timeoutMs: 60_000,
              secret: 'value',
            },
          ],
          revision: 'rev-1',
        },
        path: 'C:/agentterm/quality-gates.json',
      },
    ],
  ] as const)(
    'rejects malformed or over-capability payloads for %s',
    (channel, payload) => {
      expect(() => validateDesktopIpcRequest(channel, payload)).toThrow(
        DesktopIpcRequestValidationError,
      );
    },
  );

  it('accepts bounded onboarding requests without exposing a filesystem path', () => {
    expect(validateDesktopIpcRequest(desktopIpcChannels.openProject, {})).toEqual({});
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.createTask, {
        brief: 'Khởi động đúng agent và giữ nguyên lịch sử.',
        projectId: 'project-1',
        title: 'Sửa luồng khởi động agent',
      }),
    ).toEqual({
      brief: 'Khởi động đúng agent và giữ nguyên lịch sử.',
      projectId: 'project-1',
      title: 'Sửa luồng khởi động agent',
    });
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.beginTaskPlanning, { taskId: 'task-1' }),
    ).toEqual({ taskId: 'task-1' });
  });

  it('accepts a loadWorkspaceLayout empty payload and a bounded saveWorkspaceLayout payload', () => {
    expect(validateDesktopIpcRequest(desktopIpcChannels.loadWorkspaceLayout, {})).toEqual({});
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.saveWorkspaceLayout, {
        expectedRevision: 1,
        layout: {
          activeTabId: 'tab:1',
          tabs: [
            {
              activePaneId: 'pane:1',
              id: 'tab:1',
              panes: [{ id: 'pane:1', sessionId: undefined, taskId: 'task-1' }],
              taskId: 'task-1',
            },
          ],
        },
      }),
    ).toEqual({
      expectedRevision: 1,
      layout: {
        activeTabId: 'tab:1',
        tabs: [
          {
            activePaneId: 'pane:1',
            id: 'tab:1',
            panes: [{ id: 'pane:1', sessionId: undefined, taskId: 'task-1' }],
            taskId: 'task-1',
          },
        ],
      },
    });
  });

  it.each([
    [desktopIpcChannels.startExecution, { agentId: 'claude', taskId: ' ', token: 'secret' }],
    [desktopIpcChannels.getTaskFileDiff, { area: 'UNSTAGED', path: '../secret', taskId: 'task-1' }],
    [desktopIpcChannels.terminalResize, { columns: 0, rows: 24, subscriptionId: 'sub-1' }],
    [desktopIpcChannels.updateSettings, { expectedRevision: -1 }],
    [desktopIpcChannels.openProject, { path: 'C:\\private\\repository' }],
    [desktopIpcChannels.createTask, { projectId: 'project-1', title: 'Task' }],
    [
      desktopIpcChannels.createTask,
      { brief: 'A safe brief', projectId: 'project-1', title: '   ' },
    ],
    [desktopIpcChannels.createTask, { brief: '   ', projectId: 'project-1', title: 'Task' }],
    [
      desktopIpcChannels.createTask,
      { brief: `unsafe\u001bprompt`, projectId: 'project-1', title: 'Task' },
    ],
    [
      desktopIpcChannels.createTask,
      { brief: 'x'.repeat(16_385), projectId: 'project-1', title: 'Task' },
    ],
    [desktopIpcChannels.loadWorkspaceLayout, { path: 'C:/private.json' }],
    [
      desktopIpcChannels.saveWorkspaceLayout,
      {
        expectedRevision: 0,
        layout: { activeTabId: 'tab:1', tabs: [] },
      },
    ],
    [
      desktopIpcChannels.saveWorkspaceLayout,
      {
        expectedRevision: -1,
        layout: {
          activeTabId: 'tab:1',
          tabs: [
            {
              activePaneId: 'pane:1',
              id: 'tab:1',
              panes: [{ id: 'pane:1', sessionId: undefined, taskId: 'task-1' }],
              taskId: 'task-1',
            },
          ],
        },
      },
    ],
    [
      desktopIpcChannels.saveWorkspaceLayout,
      {
        expectedRevision: 0,
        layout: {
          activeTabId: 'tab:2',
          tabs: [
            {
              activePaneId: 'pane:1',
              id: 'tab:1',
              panes: [{ id: 'pane:1', sessionId: undefined, taskId: 'task-1' }],
              taskId: 'task-1',
            },
          ],
        },
      },
    ],
    [
      desktopIpcChannels.saveWorkspaceLayout,
      {
        expectedRevision: 0,
        layout: {
          activeTabId: 'tab:1',
          tabs: [
            {
              activePaneId: 'pane:1',
              id: 'tab:1',
              panes: [{ id: 'pane:1', sessionId: 'not valid', taskId: 'task-1' }],
              taskId: 'task-1',
            },
          ],
        },
      },
    ],
  ] as const)('rejects malformed or over-capability payloads for %s', (channel, payload) => {
    expect(() => validateDesktopIpcRequest(channel, payload)).toThrow(
      DesktopIpcRequestValidationError,
    );
  });

  it('rejects an arbitrary channel name instead of dispatching it dynamically', () => {
    expect(() =>
      validateDesktopIpcRequest('agentterm:raw-node' as never, { path: 'C:\\' }),
    ).toThrow(DesktopIpcRequestValidationError);
  });

  it('preserves bounded terminal control data that is not filesystem metadata', () => {
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.terminalWrite, {
        data: 'a\0b',
        subscriptionId: 'd14a72b9-26f6-4a9c-a810-69935ec6d277',
      }),
    ).toMatchObject({ data: 'a\0b' });
    expect(
      validateTerminalIpcEventMessage({
        event: { data: 'x\0y', kind: 'output', sequence: 1 },
        subscriptionId: 'd14a72b9-26f6-4a9c-a810-69935ec6d277',
      }),
    ).toMatchObject({ event: { data: 'x\0y' } });
  });
});
