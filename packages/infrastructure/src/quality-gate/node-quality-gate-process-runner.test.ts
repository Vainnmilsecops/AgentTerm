import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { NodeQualityGateProcessRunner } from './node-quality-gate-process-runner';

class FakeChildProcess extends EventEmitter {
  public readonly pid = 42_424;
  public readonly stdin = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly kill = vi.fn(() => true);
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('NodeQualityGateProcessRunner', () => {
  it.runIf(process.platform === 'win32')(
    'sends the exact target request only over stdin to the static Windows job host',
    async () => {
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
      const request = await readHostRequest(child);
      child.emit('spawn');
      child.stdout.write(Buffer.from('before split-', 'utf8'));
      child.stdout.write(Buffer.from('secret after', 'utf8'));
      child.stdout.write(
        hostResultFrame(request.nonce, {
          exitCode: 0,
          kind: 'exited',
          terminationFailed: false,
        }),
      );
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
        expect.stringMatching(/[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          expect.stringMatching(/[\\/]windows-job-process-host\.ps1$/u),
        ],
        expect.objectContaining({
          cwd: realpathSync.native(process.cwd()),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      );
      const spawnCall = JSON.stringify(spawnMock.mock.calls[0]);
      expect(spawnCall).not.toContain('ignored-by-double');
      expect(spawnCall).not.toContain('literal & metacharacters');
      expect(spawnCall).not.toContain('AGENTTERM_GATE_MARKER');
      expect(request).toMatchObject({
        arguments: ['-e', 'ignored-by-double', 'literal & metacharacters'],
        environment,
        executablePath: realpathSync.native(process.execPath),
        schemaVersion: 1,
        timeoutMs: 5_000,
        workingDirectory: realpathSync.native(process.cwd()),
      });
      expect(request.nonce).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

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

  it.runIf(process.platform === 'win32')(
    'returns unsettled evidence when the Windows job host protocol is malformed',
    async () => {
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
      const request = await readHostRequest(child);
      child.emit('spawn');
      child.stdout.write(
        hostResultFrame(request.nonce, {
          exitCode: 'not-a-number',
          kind: 'exited',
          terminationFailed: false,
        }),
      );
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);

      await expect(resultPromise).resolves.toEqual({
        kind: 'infrastructure-error',
        output: '',
        reason: 'TERMINATION_FAILED',
        truncated: false,
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves termination failure from the Windows job host timeout evidence',
    async () => {
      const child = new FakeChildProcess();
      spawnMock.mockReturnValue(child);

      const resultPromise = new NodeQualityGateProcessRunner().run({
        arguments: [],
        environment: {},
        executablePath: process.execPath,
        maxOutputBytes: 1_024,
        redactValues: [],
        timeoutMs: 10,
        workingDirectory: process.cwd(),
      });
      await waitForSpawn();
      const request = await readHostRequest(child);
      child.emit('spawn');
      child.stdout.write(
        hostResultFrame(request.nonce, {
          exitCode: 0,
          kind: 'timed-out',
          terminationFailed: true,
        }),
      );
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);
      await expect(resultPromise).resolves.toEqual({
        kind: 'timed-out',
        output: '',
        terminationFailed: true,
        truncated: false,
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects duplicate terminal records even when both carry the private nonce',
    async () => {
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
      const request = await readHostRequest(child);
      const terminal = hostResultFrame(request.nonce, {
        exitCode: 0,
        kind: 'exited',
        terminationFailed: false,
      });
      child.stdout.write(terminal);
      child.stdout.write(terminal);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);

      await expect(resultPromise).resolves.toMatchObject({
        kind: 'infrastructure-error',
        reason: 'TERMINATION_FAILED',
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'returns a terminal protocol failure when the host proves no writer survived setup failure',
    async () => {
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
      const request = await readHostRequest(child);
      child.stdout.write(
        hostResultFrame(request.nonce, {
          exitCode: 0,
          kind: 'infrastructure-error',
          terminationFailed: false,
        }),
      );
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 0, null);

      await expect(resultPromise).resolves.toEqual({
        kind: 'infrastructure-error',
        output: '',
        reason: 'PROCESS_PROTOCOL_ERROR',
        truncated: false,
      });
    },
  );
});

interface HostRequest {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executablePath: string;
  readonly nonce: string;
  readonly schemaVersion: number;
  readonly timeoutMs: number;
  readonly workingDirectory: string;
}

async function readHostRequest(child: FakeChildProcess): Promise<HostRequest> {
  await waitUntil(() => child.stdin.writableEnded);
  const bytes = child.stdin.read() as Buffer | null;
  if (bytes === null) throw new Error('Windows job host request was not written.');
  return JSON.parse(bytes.toString('utf8')) as HostRequest;
}

function hostResultFrame(nonce: string, result: Readonly<Record<string, unknown>>): Buffer {
  const encoded = Buffer.from(JSON.stringify(result), 'utf8').toString('base64');
  return Buffer.from(`\nAGENTTERM_JOB_RESULT:${nonce}:${encoded}\n`, 'ascii');
}

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
