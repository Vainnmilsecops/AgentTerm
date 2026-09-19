import { describe, expect, it } from 'vitest';
import { desktopIpcChannels, validateDesktopIpcRequest } from './ipc-contract';

const request = {
  taskId: 'task',
  sessionId: 'session',
  files: [{ name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([65]) }],
};
describe('context IPC boundary', () => {
  it('requires explicit worktree-copy consent and only accepts attachment identities', () => {
    const value = {
      taskId: 'task',
      sessionId: 'session',
      attachmentIds: ['file'],
      confirmWorktreeCopy: true,
    };
    expect(validateDesktopIpcRequest(desktopIpcChannels.prepareContextHandoff, value)).toEqual(
      value,
    );
    expect(() =>
      validateDesktopIpcRequest(desktopIpcChannels.prepareContextHandoff, {
        ...value,
        confirmWorktreeCopy: false,
      }),
    ).toThrow();
    expect(() =>
      validateDesktopIpcRequest(desktopIpcChannels.prepareContextHandoff, {
        ...value,
        worktreePath: 'C:/other',
      }),
    ).toThrow();
  });
  it('accepts bounded bytes without a filesystem path', () => {
    expect(validateDesktopIpcRequest(desktopIpcChannels.importTaskContext, request)).toEqual(
      request,
    );
  });
  it('rejects source path injection', () => {
    expect(() =>
      validateDesktopIpcRequest(desktopIpcChannels.importTaskContext, {
        ...request,
        sourcePath: 'C:\\secret',
      }),
    ).toThrow();
  });
  it('rejects oversized bytes before dispatch', () => {
    expect(() =>
      validateDesktopIpcRequest(desktopIpcChannels.importTaskContext, {
        ...request,
        files: [{ ...request.files[0], bytes: new Uint8Array(8 * 1024 * 1024 + 1) }],
      }),
    ).toThrow();
  });
});
