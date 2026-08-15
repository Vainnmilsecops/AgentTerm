import { describe, expect, it } from 'vitest';

import {
  createAgentSessionHostOwnership,
  InvalidAgentSessionHostOwnershipError,
  isAgentSessionHostOwnership,
  isValidProviderSessionId,
} from './agent-session-ownership';

describe('AgentSessionHostOwnership', () => {
  it('accepts a well-formed ownership record', () => {
    const ownership = createAgentSessionHostOwnership({
      conptyInPipeName: '\\\\.\\pipe\\agentterm-in-abc123',
      conptyOutPipeName: '\\\\.\\pipe\\agentterm-out-abc123',
      hostPid: 4242,
      startedAt: 1_700_000_000_000,
    });
    expect(ownership.hostPid).toBe(4242);
    expect(ownership.startedAt).toBe(1_700_000_000_000);
    expect(Object.isFrozen(ownership)).toBe(true);
  });

  it('rejects malformed pipe names', () => {
    expect(() =>
      createAgentSessionHostOwnership({
        conptyInPipeName: 'not-a-pipe',
        conptyOutPipeName: '\\\\.\\pipe\\agentterm-out-abc123',
        hostPid: 1,
        startedAt: 0,
      }),
    ).toThrow(InvalidAgentSessionHostOwnershipError);
  });

  it('rejects non-positive PIDs', () => {
    expect(() =>
      createAgentSessionHostOwnership({
        conptyInPipeName: '\\\\.\\pipe\\in',
        conptyOutPipeName: '\\\\.\\pipe\\out',
        hostPid: 0,
        startedAt: 0,
      }),
    ).toThrow(/host pid/);
  });

  it('rejects negative startedAt', () => {
    expect(() =>
      createAgentSessionHostOwnership({
        conptyInPipeName: '\\\\.\\pipe\\in',
        conptyOutPipeName: '\\\\.\\pipe\\out',
        hostPid: 1,
        startedAt: -1,
      }),
    ).toThrow(/startedAt/);
  });

  it('isAgentSessionHostOwnership narrows correctly', () => {
    const ownership = createAgentSessionHostOwnership({
      conptyInPipeName: '\\\\.\\pipe\\x',
      conptyOutPipeName: '\\\\.\\pipe\\y',
      hostPid: 7,
      startedAt: 0,
    });
    expect(isAgentSessionHostOwnership(ownership)).toBe(true);
    expect(isAgentSessionHostOwnership(null)).toBe(false);
    expect(isAgentSessionHostOwnership({})).toBe(false);
  });

  it('isValidProviderSessionId enforces a defensive shape', () => {
    expect(isValidProviderSessionId('abc_123-xyz')).toBe(true);
    expect(isValidProviderSessionId('ab')).toBe(false);
    expect(isValidProviderSessionId('has spaces')).toBe(false);
    expect(isValidProviderSessionId('has;semicolon')).toBe(false);
  });
});
