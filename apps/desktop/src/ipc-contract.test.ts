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

  it('accepts bounded onboarding requests without exposing a filesystem path', () => {
    expect(validateDesktopIpcRequest(desktopIpcChannels.openProject, {})).toEqual({});
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.createTask, {
        projectId: 'project-1',
        title: 'Sửa luồng khởi động agent',
      }),
    ).toEqual({ projectId: 'project-1', title: 'Sửa luồng khởi động agent' });
    expect(
      validateDesktopIpcRequest(desktopIpcChannels.beginTaskPlanning, { taskId: 'task-1' }),
    ).toEqual({ taskId: 'task-1' });
  });

  it.each([
    [desktopIpcChannels.startExecution, { agentId: 'claude', taskId: ' ', token: 'secret' }],
    [desktopIpcChannels.getTaskFileDiff, { area: 'UNSTAGED', path: '../secret', taskId: 'task-1' }],
    [desktopIpcChannels.terminalResize, { columns: 0, rows: 24, subscriptionId: 'sub-1' }],
    [desktopIpcChannels.updateSettings, { expectedRevision: -1 }],
    [desktopIpcChannels.openProject, { path: 'C:\\private\\repository' }],
    [desktopIpcChannels.createTask, { projectId: 'project-1', title: '   ' }],
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
