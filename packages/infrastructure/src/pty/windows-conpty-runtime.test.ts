import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PtyRuntimeError,
  type PtyLaunchSpec,
  type PtyRuntimeEvent,
  type PtyRuntimeFailureReason,
  type PtyRuntimeOperation,
} from '@agentterm/application';

import { WindowsConPtyRuntime } from './windows-conpty-runtime';

const hostSpawn = vi.hoisted(() => vi.fn());

vi.mock('./windows-conpty-host-client', () => ({ spawnWindowsConPtyHost: hostSpawn }));

interface BackendExitEvent {
  readonly exitCode: number | undefined;
  readonly signal?: number;
}

class FakePty {
  public readonly clear = vi.fn();
  public readonly cols = 80;
  public readonly handle = 9124;
  public readonly kill = vi.fn();
  public readonly pause = vi.fn();
  public pid = 4812;
  public readonly process = 'fixture-terminal.exe';
  public readonly resize = vi.fn<(columns: number, rows: number) => void>();
  public readonly resume = vi.fn();
  public readonly rows = 24;
  public readonly write = vi.fn<(input: string) => void>();
  public readonly writeBuffer = vi.fn();

  public readonly disposeDataSubscription = vi.fn();
  public readonly disposeExitSubscription = vi.fn();
  public dataDuringSubscription: string | undefined;
  public exitDuringSubscription: BackendExitEvent | undefined;
  public exitSubscriptionError: Error | undefined;

  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((event: BackendExitEvent) => void) | undefined;

  public readonly onData = vi.fn((listener: (data: string) => void) => {
    this.dataListener = listener;
    if (this.dataDuringSubscription !== undefined) {
      listener(this.dataDuringSubscription);
    }
    return { dispose: this.disposeDataSubscription };
  });

  public readonly onExit = vi.fn((listener: (event: BackendExitEvent) => void) => {
    if (this.exitSubscriptionError !== undefined) {
      throw this.exitSubscriptionError;
    }

    this.exitListener = listener;
    if (this.exitDuringSubscription !== undefined) {
      listener(this.exitDuringSubscription);
    }
    return { dispose: this.disposeExitSubscription };
  });

  /** Deliberately invokes the retained callback even after subscription disposal to model a race. */
  public emitData(data: string): void {
    this.dataListener?.(data);
  }

  public emitExit(exitCode: number, signal: number): void {
    this.exitListener?.({ exitCode, signal });
  }

  public emitMalformedExit(): void {
    this.exitListener?.({ exitCode: undefined });
  }
}

interface RuntimeFixture {
  readonly events: PtyRuntimeEvent[];
  readonly executablePath: string;
  readonly fakePty: FakePty;
  readonly rootPath: string;
  readonly spec: PtyLaunchSpec;
  readonly workingDirectory: string;
}

let fixture: RuntimeFixture;

function createFixture(): RuntimeFixture {
  const rootPath = mkdtempSync(join(tmpdir(), 'agentterm-conpty-unit-'));
  const executablePath = join(rootPath, 'fixture-terminal.exe');
  const workingDirectory = join(rootPath, 'working-directory');
  const fakePty = new FakePty();
  const events: PtyRuntimeEvent[] = [];

  writeFileSync(executablePath, 'fixture executable');
  mkdirSync(workingDirectory);

  return {
    events,
    executablePath,
    fakePty,
    rootPath,
    spec: {
      arguments: ['--literal', 'value with spaces'],
      environment: { AGENTTERM_FIXTURE: 'explicit-value' },
      executablePath,
      initialSize: { columns: 80, rows: 24 },
      workingDirectory,
    },
    workingDirectory,
  };
}

async function captureRuntimeError(attempt: Promise<unknown>): Promise<PtyRuntimeError> {
  const error: unknown = await attempt.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(PtyRuntimeError);
  return error as PtyRuntimeError;
}

async function expectRuntimeFailure(
  attempt: Promise<unknown>,
  operation: PtyRuntimeOperation,
  reason: PtyRuntimeFailureReason,
): Promise<void> {
  const error = await captureRuntimeError(attempt);

  expect(error).toMatchObject({ name: 'PtyRuntimeError', operation, reason });
}

beforeEach(() => {
  fixture = createFixture();
  hostSpawn.mockReset();
  hostSpawn.mockReturnValue(fixture.fakePty);
});

afterEach(() => {
  rmSync(fixture.rootPath, { force: true, recursive: true });
});

describe.runIf(process.platform === 'win32')('WindowsConPtyRuntime', () => {
  it('passes a canonical structured launch specification and only its explicit environment to ConPTY', async () => {
    const runtime = new WindowsConPtyRuntime();
    const nonCanonicalWorkingDirectory = join(fixture.workingDirectory, '..', 'working-directory');

    await runtime.open(
      { ...fixture.spec, workingDirectory: nonCanonicalWorkingDirectory },
      (event) => fixture.events.push(event),
    );

    expect(hostSpawn).toHaveBeenCalledOnce();
    expect(hostSpawn).toHaveBeenCalledWith({
      arguments: ['--literal', 'value with spaces'],
      environment: { AGENTTERM_FIXTURE: 'explicit-value' },
      executablePath: realpathSync.native(fixture.executablePath),
      initialColumns: 80,
      initialRows: 24,
      workingDirectory: realpathSync.native(fixture.workingDirectory),
    });
    expect(fixture.events).toEqual([{ kind: 'started', sequence: 1 }]);
  });

  it.each([
    {
      label: 'a relative executable path',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        executablePath: 'fixture-terminal.exe',
      }),
      reason: 'INVALID_EXECUTABLE' as const,
    },
    {
      label: 'a missing executable file',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        executablePath: join(fixture.rootPath, 'missing.exe'),
      }),
      reason: 'INVALID_EXECUTABLE' as const,
    },
    {
      label: 'a directory as the executable',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        executablePath: fixture.workingDirectory,
      }),
      reason: 'INVALID_EXECUTABLE' as const,
    },
    {
      label: 'a relative working directory',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        workingDirectory: 'relative-working-directory',
      }),
      reason: 'INVALID_WORKING_DIRECTORY' as const,
    },
    {
      label: 'a missing working directory',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        workingDirectory: join(fixture.rootPath, 'missing-directory'),
      }),
      reason: 'INVALID_WORKING_DIRECTORY' as const,
    },
    {
      label: 'a file as the working directory',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        workingDirectory: fixture.executablePath,
      }),
      reason: 'INVALID_WORKING_DIRECTORY' as const,
    },
    {
      label: 'an argument containing NUL',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        arguments: ['safe', 'unsafe\0argument'],
      }),
      reason: 'INVALID_ARGUMENT' as const,
    },
    {
      label: 'an empty environment name',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        environment: { '': 'value' },
      }),
      reason: 'INVALID_ENVIRONMENT' as const,
    },
    {
      label: 'an environment name containing equals',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        environment: { 'BAD=NAME': 'value' },
      }),
      reason: 'INVALID_ENVIRONMENT' as const,
    },
    {
      label: 'an environment name containing NUL',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        environment: { 'BAD\0NAME': 'value' },
      }),
      reason: 'INVALID_ENVIRONMENT' as const,
    },
    {
      label: 'an environment value containing NUL',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        environment: { SAFE_NAME: 'unsafe\0value' },
      }),
      reason: 'INVALID_ENVIRONMENT' as const,
    },
    {
      label: 'case-insensitively duplicated environment names',
      mutate: (spec: PtyLaunchSpec): PtyLaunchSpec => ({
        ...spec,
        environment: { Path: 'first', PATH: 'second' },
      }),
      reason: 'INVALID_ENVIRONMENT' as const,
    },
  ])('rejects $label before allocating a PTY', async ({ mutate, reason }) => {
    const runtime = new WindowsConPtyRuntime();

    await expectRuntimeFailure(
      runtime.open(mutate(fixture.spec), (event) => fixture.events.push(event)),
      'spawn',
      reason,
    );

    expect(hostSpawn).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([{ kind: 'failed', operation: 'spawn', reason, sequence: 1 }]);
  });

  it.each([
    { columns: 0, label: 'zero columns', rows: 24 },
    { columns: 80, label: 'zero rows', rows: 0 },
    { columns: 1.5, label: 'fractional columns', rows: 24 },
    { columns: 80, label: 'fractional rows', rows: 2.5 },
    { columns: 32_768, label: 'columns above the ConPTY limit', rows: 24 },
    { columns: 80, label: 'rows above the ConPTY limit', rows: 32_768 },
  ])('rejects initial terminal size with $label before spawning', async ({ columns, rows }) => {
    const runtime = new WindowsConPtyRuntime();

    await expectRuntimeFailure(
      runtime.open({ ...fixture.spec, initialSize: { columns, rows } }, (event) =>
        fixture.events.push(event),
      ),
      'spawn',
      'INVALID_TERMINAL_SIZE',
    );

    expect(hostSpawn).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      {
        kind: 'failed',
        operation: 'spawn',
        reason: 'INVALID_TERMINAL_SIZE',
        sequence: 1,
      },
    ]);
  });

  it('sanitizes terminal-size accessors that throw before they reach the native backend', async () => {
    const runtime = new WindowsConPtyRuntime();
    const unsafeSize = Object.defineProperty({}, 'columns', {
      enumerable: true,
      get: () => {
        throw new Error('terminal-size secret');
      },
    }) as { columns: number; rows: number };

    const openError = await captureRuntimeError(
      runtime.open({ ...fixture.spec, initialSize: unsafeSize }, (event) =>
        fixture.events.push(event),
      ),
    );

    expect(openError).toMatchObject({ operation: 'spawn', reason: 'INVALID_TERMINAL_SIZE' });
    expect(String(openError)).not.toContain('terminal-size secret');
    expect(hostSpawn).not.toHaveBeenCalled();

    fixture.events.length = 0;
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    const resizeError = await captureRuntimeError(handle.resize(unsafeSize));

    expect(resizeError).toMatchObject({
      operation: 'resize',
      reason: 'INVALID_TERMINAL_SIZE',
    });
    expect(String(resizeError)).not.toContain('terminal-size secret');
    expect(fixture.fakePty.resize).not.toHaveBeenCalled();

    const cleanup = handle.dispose();
    fixture.fakePty.emitExit(0, 0);
    await cleanup;
  });

  it('emits started first, preserves output order, emits exit last, and ignores late backend data', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    fixture.fakePty.emitData('first');
    fixture.fakePty.emitData(' second');
    fixture.fakePty.emitExit(7, 15);
    fixture.fakePty.emitData('late data that must be ignored');
    fixture.fakePty.emitExit(99, 9);

    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { data: 'first', kind: 'output', sequence: 2 },
      { data: ' second', kind: 'output', sequence: 3 },
      { exitCode: 7, kind: 'exited', sequence: 4, signal: 15 },
    ]);
    expect(fixture.fakePty.disposeDataSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.disposeExitSubscription).toHaveBeenCalledOnce();

    await handle.dispose();

    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
    expect(fixture.fakePty.disposeDataSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.disposeExitSubscription).toHaveBeenCalledOnce();
  });

  it('orders backend callbacks that fire synchronously while listeners are being registered', async () => {
    const runtime = new WindowsConPtyRuntime();
    fixture.fakePty.dataDuringSubscription = 'synchronous output';
    fixture.fakePty.exitDuringSubscription = { exitCode: 6, signal: 0 };

    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { data: 'synchronous output', kind: 'output', sequence: 2 },
      { exitCode: 6, kind: 'exited', sequence: 3, signal: 0 },
    ]);
    expect(fixture.fakePty.disposeDataSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.disposeExitSubscription).toHaveBeenCalledOnce();
    await handle.dispose();
    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
  });

  it('distinguishes asynchronous native bootstrap failure from a process exit', async () => {
    const runtime = new WindowsConPtyRuntime();
    fixture.fakePty.pid = 0;
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    fixture.fakePty.emitExit(-1, -1);

    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { kind: 'failed', operation: 'spawn', reason: 'RUNTIME_FAILURE', sequence: 2 },
      { exitCode: -1, kind: 'exited', sequence: 3 },
    ]);
    await handle.dispose();
    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
  });

  it('reports output-worker failure after process start as a runtime failure', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    fixture.fakePty.emitExit(-1, -1);

    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { kind: 'failed', operation: 'runtime', reason: 'RUNTIME_FAILURE', sequence: 2 },
      { exitCode: -1, kind: 'exited', sequence: 3 },
    ]);
    await handle.dispose();
    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
  });

  it('normalizes missing native exit evidence into a runtime failure', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    fixture.fakePty.emitMalformedExit();

    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { kind: 'failed', operation: 'runtime', reason: 'RUNTIME_FAILURE', sequence: 2 },
      { exitCode: -1, kind: 'exited', sequence: 3 },
    ]);
    await handle.dispose();
    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
  });

  it('forwards input and valid resize requests to the owned PTY', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    await handle.write('dir /b\r');
    await handle.resize({ columns: 32767, rows: 1 });

    expect(fixture.fakePty.write).toHaveBeenCalledWith('dir /b\r');
    expect(fixture.fakePty.resize).toHaveBeenCalledWith(32767, 1);
    expect(fixture.events).toEqual([{ kind: 'started', sequence: 1 }]);
  });

  it('reports invalid input without forwarding it to the owned PTY', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    await expectRuntimeFailure(handle.write(null as unknown as string), 'write', 'INVALID_INPUT');

    expect(fixture.fakePty.write).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { kind: 'failed', operation: 'write', reason: 'INVALID_INPUT', sequence: 2 },
    ]);
  });

  it('sanitizes native write and resize failures while keeping the PTY terminable', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    fixture.fakePty.write.mockImplementationOnce(() => {
      throw new Error('native write secret');
    });
    fixture.fakePty.resize.mockImplementationOnce(() => {
      throw new Error('native resize secret');
    });

    const writeError = await captureRuntimeError(handle.write('input'));
    const resizeError = await captureRuntimeError(handle.resize({ columns: 90, rows: 30 }));

    expect(writeError).toMatchObject({ operation: 'write', reason: 'RUNTIME_FAILURE' });
    expect(resizeError).toMatchObject({ operation: 'resize', reason: 'RUNTIME_FAILURE' });
    expect(String(writeError)).not.toContain('native write secret');
    expect(String(resizeError)).not.toContain('native resize secret');

    const termination = handle.terminate();
    fixture.fakePty.emitExit(1, 15);
    await termination;

    expect(fixture.fakePty.kill).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { kind: 'failed', operation: 'write', reason: 'RUNTIME_FAILURE', sequence: 2 },
      { kind: 'failed', operation: 'resize', reason: 'RUNTIME_FAILURE', sequence: 3 },
      { exitCode: 1, kind: 'exited', sequence: 4, signal: 15 },
    ]);
  });

  it.each([
    { columns: 0, rows: 24 },
    { columns: 80, rows: 0 },
    { columns: Number.NaN, rows: 24 },
    { columns: 80, rows: Number.POSITIVE_INFINITY },
    { columns: 32_768, rows: 24 },
    { columns: 80, rows: 32_768 },
  ])('rejects an invalid resize without touching the owned PTY', async (size) => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));

    await expectRuntimeFailure(handle.resize(size), 'resize', 'INVALID_TERMINAL_SIZE');

    expect(fixture.fakePty.resize).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      {
        kind: 'failed',
        operation: 'resize',
        reason: 'INVALID_TERMINAL_SIZE',
        sequence: 2,
      },
    ]);
  });

  it('rejects write and resize after exit without appending an event after exited', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    fixture.fakePty.emitExit(0, 0);

    await expectRuntimeFailure(handle.write('late input'), 'write', 'NOT_RUNNING');
    await expectRuntimeFailure(handle.resize({ columns: 90, rows: 30 }), 'resize', 'NOT_RUNNING');

    expect(fixture.fakePty.write).not.toHaveBeenCalled();
    expect(fixture.fakePty.resize).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { exitCode: 0, kind: 'exited', sequence: 2, signal: 0 },
    ]);
  });

  it('coalesces concurrent terminate and dispose requests, kills once, and awaits process exit', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    let cleanupSettled = false;

    const cleanup = Promise.all([handle.terminate(), handle.dispose(), handle.terminate()]).then(
      () => {
        cleanupSettled = true;
      },
    );
    await Promise.resolve();

    expect(fixture.fakePty.kill).toHaveBeenCalledOnce();
    expect(cleanupSettled).toBe(false);

    fixture.fakePty.emitExit(1, 15);
    await cleanup;
    await handle.dispose();

    expect(fixture.fakePty.kill).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      { exitCode: 1, kind: 'exited', sequence: 2, signal: 15 },
    ]);
    expect(fixture.fakePty.disposeDataSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.disposeExitSubscription).toHaveBeenCalledOnce();
  });

  it('does not kill a process that already exited naturally', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    fixture.fakePty.emitExit(0, 0);

    await handle.terminate();
    await handle.dispose();

    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
  });

  it('preserves exit evidence when listener cleanup also fails', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    fixture.fakePty.disposeDataSubscription.mockImplementationOnce(() => {
      throw new Error('listener cleanup detail');
    });

    fixture.fakePty.emitExit(4, 0);
    await Promise.all([handle.dispose(), handle.terminate(), handle.dispose()]);
    await handle.dispose();

    expect(fixture.fakePty.disposeDataSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.disposeExitSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.kill).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      {
        kind: 'failed',
        operation: 'cleanup',
        reason: 'RUNTIME_FAILURE',
        sequence: 2,
      },
      { exitCode: 4, kind: 'exited', sequence: 3, signal: 0 },
    ]);
  });

  it('emits a sanitized failure and permits a safe termination retry when kill throws', async () => {
    const runtime = new WindowsConPtyRuntime();
    const handle = await runtime.open(fixture.spec, (event) => fixture.events.push(event));
    fixture.fakePty.kill
      .mockImplementationOnce(() => {
        throw new Error('sensitive-token-from-native-error');
      })
      .mockImplementationOnce(() => undefined);

    const firstError = await captureRuntimeError(handle.terminate());

    expect(firstError).toMatchObject({
      operation: 'terminate',
      reason: 'RUNTIME_FAILURE',
    });
    expect(String(firstError)).not.toContain('sensitive-token-from-native-error');
    expect(fixture.events).toEqual([
      { kind: 'started', sequence: 1 },
      {
        kind: 'failed',
        operation: 'terminate',
        reason: 'RUNTIME_FAILURE',
        sequence: 2,
      },
    ]);

    await expectRuntimeFailure(handle.write('must not be accepted'), 'write', 'NOT_RUNNING');
    await expectRuntimeFailure(handle.resize({ columns: 90, rows: 30 }), 'resize', 'NOT_RUNNING');
    expect(fixture.fakePty.write).not.toHaveBeenCalled();
    expect(fixture.fakePty.resize).not.toHaveBeenCalled();

    const retry = handle.terminate();
    fixture.fakePty.emitExit(1, 15);
    await retry;

    expect(fixture.fakePty.kill).toHaveBeenCalledTimes(2);
    expect(fixture.events.at(-1)).toEqual({
      exitCode: 1,
      kind: 'exited',
      sequence: 3,
      signal: 15,
    });
  });

  it('cleans partially registered listeners and kills the owned PTY when exit subscription fails', async () => {
    const runtime = new WindowsConPtyRuntime();
    fixture.fakePty.exitSubscriptionError = new Error('native subscription secret');

    const error = await captureRuntimeError(
      runtime.open(fixture.spec, (event) => fixture.events.push(event)),
    );

    expect(error).toMatchObject({ operation: 'spawn', reason: 'RUNTIME_FAILURE' });
    expect(String(error)).not.toContain('native subscription secret');
    expect(fixture.fakePty.disposeDataSubscription).toHaveBeenCalledOnce();
    expect(fixture.fakePty.kill).toHaveBeenCalledOnce();
    expect(fixture.events).toEqual([
      {
        kind: 'failed',
        operation: 'spawn',
        reason: 'RUNTIME_FAILURE',
        sequence: 1,
      },
    ]);
  });

  it('maps a native spawn exception to a sanitized terminal failure without leaking the launch environment', async () => {
    const runtime = new WindowsConPtyRuntime();
    hostSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed with token explicit-value');
    });

    const error = await captureRuntimeError(
      runtime.open(fixture.spec, (event) => fixture.events.push(event)),
    );

    expect(error).toMatchObject({ operation: 'spawn', reason: 'RUNTIME_FAILURE' });
    expect(String(error)).not.toContain('explicit-value');
    expect(fixture.events).toEqual([
      {
        kind: 'failed',
        operation: 'spawn',
        reason: 'RUNTIME_FAILURE',
        sequence: 1,
      },
    ]);
  });
});
