import { describe, expect, it } from 'vitest';

import {
  completeQualityGateRun,
  createQualityGate,
  startQualityGateRun,
  QualityGateKind,
  QualityGateRunStatus,
} from './index';

const gate = createQualityGate({
  command: {
    arguments: ['--filter', '@agentterm/domain', 'test'],
    executablePath: 'C:\\Program Files\\nodejs\\node.exe',
  },
  id: 'test',
  kind: QualityGateKind.TEST,
  timeoutMs: 120_000,
});

const worktree = {
  baseCommitId: 'a'.repeat(40),
  branchName: 'agentterm/task/abc123',
  headCommitIdAtStart: 'b'.repeat(40),
  pathIdentity: 'worktree-identity',
  worktreePath: 'D:\\AgentTerm Worktrees\\task-1',
};

describe('QualityGate', () => {
  it('creates a deeply immutable structured command without shell syntax', () => {
    expect(gate).toEqual({
      command: {
        arguments: ['--filter', '@agentterm/domain', 'test'],
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
      },
      id: 'test',
      kind: 'TEST',
      timeoutMs: 120_000,
    });
    expect(Object.isFrozen(gate)).toBe(true);
    expect(Object.isFrozen(gate.command)).toBe(true);
    expect(Object.isFrozen(gate.command.arguments)).toBe(true);
  });

  it.each([
    { ...gate, id: ' ' },
    { ...gate, id: 'bad\0gate' },
    { ...gate, timeoutMs: 0 },
    { ...gate, command: { ...gate.command, executablePath: '' } },
    { ...gate, command: { ...gate.command, arguments: ['ok', 'bad\0argument'] } },
  ])('rejects invalid definitions', (input) => {
    expect(() => createQualityGate(input)).toThrow(TypeError);
  });
});

describe('QualityGateRun', () => {
  it('starts as RUNNING with immutable gate and Worktree provenance', () => {
    const run = startQualityGateRun({
      gate,
      id: 'run-1',
      startedAt: 1_000,
      taskId: 'task-1',
      worktree,
    });

    expect(run).toEqual({
      durationMs: undefined,
      exitCode: undefined,
      failureCategory: undefined,
      finishedAt: undefined,
      gate,
      id: 'run-1',
      output: undefined,
      startedAt: 1_000,
      status: 'RUNNING',
      taskId: 'task-1',
      worktree,
    });
    expect(Object.isFrozen(run.worktree)).toBe(true);
  });

  it.each([
    { kind: 'exited' as const, exitCode: 0, expected: QualityGateRunStatus.PASSED },
    { kind: 'exited' as const, exitCode: 2, expected: QualityGateRunStatus.FAILED },
    { kind: 'timed-out' as const, expected: QualityGateRunStatus.TIMED_OUT },
    { kind: 'launch-failed' as const, expected: QualityGateRunStatus.LAUNCH_FAILED },
    {
      kind: 'infrastructure-failed' as const,
      expected: QualityGateRunStatus.INFRASTRUCTURE_FAILED,
    },
  ])('records $expected terminal evidence without changing the prior snapshot', (result) => {
    const running = startQualityGateRun({
      gate,
      id: `run-${result.expected}`,
      startedAt: 1_000,
      taskId: 'task-1',
      worktree,
    });
    const completed = completeQualityGateRun(running, {
      ...result,
      finishedAt: 1_075,
      output: {
        reference: `quality-gate-output:${running.id}`,
        text: 'Ki\u1ec3m tra ho\u00e0n t\u1ea5t',
        truncated: false,
      },
    });

    expect(completed).toMatchObject({
      durationMs: 75,
      finishedAt: 1_075,
      status: result.expected,
    });
    expect(running.status).toBe(QualityGateRunStatus.RUNNING);
    expect(completed.failureCategory).toBe(
      result.expected === 'FAILED'
        ? 'COMMAND'
        : result.expected === 'TIMED_OUT'
          ? 'TIMEOUT'
          : result.expected === 'LAUNCH_FAILED'
            ? 'LAUNCH'
            : result.expected === 'INFRASTRUCTURE_FAILED'
              ? 'INFRASTRUCTURE'
              : undefined,
    );
  });

  it('requires a nonzero exit code for FAILED and cannot complete a terminal run twice', () => {
    const running = startQualityGateRun({
      gate,
      id: 'run-2',
      startedAt: 2_000,
      taskId: 'task-1',
      worktree,
    });
    const output = { reference: 'quality-gate-output:run-2', text: '', truncated: false };

    expect(() =>
      completeQualityGateRun(running, {
        exitCode: Number.NaN,
        finishedAt: 2_001,
        kind: 'exited',
        output,
      }),
    ).toThrow(TypeError);

    const passed = completeQualityGateRun(running, {
      exitCode: 0,
      finishedAt: 2_001,
      kind: 'exited',
      output,
    });
    expect(() =>
      completeQualityGateRun(passed, {
        exitCode: 0,
        finishedAt: 2_002,
        kind: 'exited',
        output,
      }),
    ).toThrow();
  });

  it('rejects invalid identity, chronology, provenance, and output references', () => {
    expect(() =>
      startQualityGateRun({ gate, id: '', startedAt: 1, taskId: 'task-1', worktree }),
    ).toThrow(TypeError);
    expect(() =>
      startQualityGateRun({ gate, id: 'run\0bad', startedAt: 1, taskId: 'task-1', worktree }),
    ).toThrow(TypeError);
    expect(() =>
      startQualityGateRun({
        gate,
        id: 'run-bad-commit',
        startedAt: 1,
        taskId: 'task-1',
        worktree: { ...worktree, baseCommitId: 'not-a-commit' },
      }),
    ).toThrow(TypeError);

    const running = startQualityGateRun({
      gate,
      id: 'run-3',
      startedAt: 10,
      taskId: 'task-1',
      worktree,
    });
    expect(() =>
      completeQualityGateRun(running, {
        exitCode: 0,
        finishedAt: 9,
        kind: 'exited',
        output: { reference: ' ', text: 'secret-safe', truncated: false },
      }),
    ).toThrow(TypeError);
  });
});
