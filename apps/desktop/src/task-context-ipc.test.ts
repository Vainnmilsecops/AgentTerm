import { describe, expect, it } from 'vitest';
import { desktopIpcChannels, validateDesktopIpcRequest } from './ipc-contract';

const request = {
  taskId: 'task',
  sessionId: 'session',
  files: [{ name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([65]) }],
};
describe('context IPC boundary', () => {
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
