import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

import { NodeQualityGateProcessRunner } from './node-quality-gate-process-runner';

class FakeChildProcess extends EventEmitter {
  public readonly pid = 42_424;
  public readonly stderr = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly kill = vi.fn(() => true);
}

beforeEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
});

describe('NodeQualityGateProcessRunner', () => {
  it('spawns one native process without a shell and redacts output split across chunks', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);
    const environment = { AGENTTERM_GATE_MARKER: 'exact' };

    const resultPromise = new NodeQualityGateProcessRunner().run({
      arguments: ['-e', 'ignored-by-double', 'literal & metacharacters'],
      environment,
      executablePath: process.execPath,
      maxOutputBytes: 1_024,
      redactValues: ['split-secret'],
      timeoutMs: 5_000,
      workingDirectory: process.cwd(),
    });
    await waitForSpawn();
    child.emit('spawn');
    child.stdout.write(Buffer.from('before split-', 'utf8'));
    child.stdout.write(Buffer.from('secret after', 'utf8'));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      kind: 'exited',
      output: 'before [REDACTED] after',
      truncated: false,
    });
    expect(spawnMock).toHaveBeenCalledWith(
      realpathSync.native(process.execPath),
      ['-e', 'ignored-by-double', 'literal & metacharacters'],
      expect.objectContaining({
        cwd: realpathSync.native(process.cwd()),
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });

  it('rejects malformed environment input without spawning or leaking its validation error', async () => {
    const secret = 'secret-from-environment-getter';
    const environment = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error(secret);
        },
      },
    ) as Readonly<Record<string, string>>;

    const result = await new NodeQualityGateProcessRunner().run({
      arguments: [],
      environment,
      executablePath: process.execPath,
      maxOutputBytes: 1_024,
      redactValues: [],
      timeoutMs: 5_000,
      workingDirectory: process.cwd(),
    });

    expect(result).toEqual({
      kind: 'launch-error',
      output: '',
      reason: 'INVALID_REQUEST',
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports a process protocol error when exit evidence has no numeric code', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child);

    const resultPromise = new NodeQualityGateProcessRunner().run({
      arguments: [],
      environment: {},
      executablePath: process.execPath,
      maxOutputBytes: 1_024,
      redactValues: [],
      timeoutMs: 5_000,
      workingDirectory: process.cwd(),
    });
    await waitForSpawn();
    child.emit('spawn');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', null, 'SIGTERM');

    await expect(resultPromise).resolves.toEqual({
      kind: 'infrastructure-error',
      output: '',
      reason: 'PROCESS_PROTOCOL_ERROR',
      truncated: false,
    });
  });

  it.runIf(process.platform === 'win32')(
    'waits for process-tree termination evidence before reporting a timeout',
    async () => {
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);
      let finishTaskkill: ((error: Error | null) => void) | undefined;
      execFileMock.mockImplementation(
        (
          _executable: string,
          _arguments: readonly string[],
          _options: unknown,
          callback: (error: Error | null) => void,
        ) => {
          finishTaskkill = callback;
          return undefined;
        },
      );

      let settled = false;
      const resultPromise = new NodeQualityGateProcessRunner()
        .run({
          arguments: [],
          environment: {},
          executablePath: process.execPath,
          maxOutputBytes: 1_024,
          redactValues: [],
          timeoutMs: 10,
          workingDirectory: process.cwd(),
        })
        .then((result) => {
          settled = true;
          return result;
        });
      await waitForSpawn();
      child.emit('spawn');
      await waitUntil(() => execFileMock.mock.calls.length === 1);
      expect(execFileMock).toHaveBeenCalledWith(
        expect.stringMatching(/[\\/]System32[\\/]taskkill\.exe$/iu),
        ['/PID', String(child.pid), '/T', '/F'],
        expect.objectContaining({ shell: false, windowsHide: true }),
        expect.any(Function),
      );
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1, null);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settled).toBe(false);
      finishTaskkill?.(new Error('taskkill failed'));
      await expect(resultPromise).resolves.toEqual({
        kind: 'timed-out',
        output: '',
        terminationFailed: true,
        truncated: false,
      });
    },
  );
});

async function waitForSpawn(): Promise<void> {
  await waitUntil(() => spawnMock.mock.calls.length > 0);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Quality-gate process test condition was not reached by the deadline.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
