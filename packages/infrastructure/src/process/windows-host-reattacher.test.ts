import { describe, expect, it } from 'vitest';

import { NodeHostReattacher } from './windows-host-reattacher';
import type { AgentSessionHostOwnership } from '@agentterm/application';

function ownership(pid = 9999): AgentSessionHostOwnership {
  return {
    conptyInPipeName: '\\\\.\\pipe\\in',
    conptyOutPipeName: '\\\\.\\pipe\\out',
    hostPid: pid,
    startedAt: 0,
  };
}

describe('NodeHostReattacher', () => {
  it('reports PROCESS_GONE when the alive probe returns false', async () => {
    const reattacher = new NodeHostReattacher(
      'win32',
      () => false,
      () => true,
    );
    expect(await reattacher.inspect(ownership())).toEqual({
      kind: 'dead',
      reason: 'PROCESS_GONE',
    });
  });

  it('reports PIPE_GONE when pipes are missing even though the pid is alive', async () => {
    const reattacher = new NodeHostReattacher(
      'win32',
      () => true,
      () => false,
    );
    expect(await reattacher.inspect(ownership())).toEqual({
      kind: 'dead',
      reason: 'PIPE_GONE',
    });
  });

  it('reports alive when both probes succeed', async () => {
    const reattacher = new NodeHostReattacher(
      'win32',
      () => true,
      () => true,
    );
    expect(await reattacher.inspect(ownership())).toEqual({ kind: 'alive' });
  });

  it('rejects non-positive pids before probing', async () => {
    const reattacher = new NodeHostReattacher(
      'win32',
      () => true,
      () => true,
    );
    expect(await reattacher.inspect(ownership(0))).toEqual({
      kind: 'dead',
      reason: 'PROCESS_GONE',
    });
  });
});
