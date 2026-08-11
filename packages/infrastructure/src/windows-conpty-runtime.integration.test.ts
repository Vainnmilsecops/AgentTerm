import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PtyRuntimeError, type PtyHandle, type PtyRuntimeEvent } from '@agentterm/application';

import { WindowsConPtyRuntime } from './index';

const CHILD_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const marker = process.env.AGENTTERM_PTY_MARKER;
const inherited = process.env.AGENTTERM_PTY_PARENT_SENTINEL ?? 'absent';
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
process.stdout.write('READY:' + marker + ':' + inherited + ':' + process.cwd() + ':' + process.stdout.columns + 'x' + process.stdout.rows + '\n');
let pending = '';
const watchdog = setTimeout(() => process.exit(91), 8000);
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const commands = pending.split(/[\r\n]+/u);
  pending = commands.pop() ?? '';
  for (const command of commands) {
    if (command === '') continue;
    if (command === 'size') {
      const probe = spawnSync(
        process.env.AGENTTERM_PTY_POWERSHELL,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::WriteLine(('SIZE:{0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight))"],
        { stdio: 'inherit', windowsHide: true },
      );
      if (probe.status !== 0) process.stdout.write('SIZE-PROBE-FAILED:' + probe.status + '\n');
    } else if (command === 'exit') {
      clearTimeout(watchdog);
      process.stdout.write('DONE\n', () => process.exit(23));
    } else {
      process.stdout.write('INPUT:' + command + '\n');
    }
  }
});
`;

const SILENT_INPUT_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
const watchdog = setTimeout(() => process.exit(95), 8000);
process.stdin.once('data', (data) => {
  clearTimeout(watchdog);
  const probe = spawnSync(
    process.env.AGENTTERM_PTY_POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "[Console]::WriteLine(('EARLY-SIZE:{0}x{1}' -f [Console]::WindowWidth,[Console]::WindowHeight))"],
    { stdio: 'inherit', windowsHide: true },
  );
  if (probe.status !== 0) process.stdout.write('EARLY-SIZE-PROBE-FAILED:' + probe.status + '\n');
  process.stdout.write('EARLY-INPUT:' + data.trim() + '\n', () => process.exit(24));
});
`;

const DESCENDANT_SCRIPT = String.raw`
const { spawn } = require('node:child_process');
const descendant = spawn(
  process.execPath,
  ['-e', 'setTimeout(() => process.exit(96), 8000);'],
  { env: process.env, stdio: 'ignore', windowsHide: true },
);
process.stdout.write('DESCENDANT:' + descendant.pid + '\n');
setTimeout(() => process.exit(97), 8000);
`;

describe('WindowsConPtyRuntime real ConPTY integration', () => {
  it.runIf(process.platform === 'win32')(
    'preserves cwd, exact environment, input/output order, resize, exit, and cleanup',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY thử nghiệm ')),
      );
      const runtime = new WindowsConPtyRuntime();
      const events: PtyRuntimeEvent[] = [];
      let handle: PtyHandle | undefined;
      let resolveExit: ((event: Extract<PtyRuntimeEvent, { kind: 'exited' }>) => void) | undefined;
      const exited = new Promise<Extract<PtyRuntimeEvent, { kind: 'exited' }>>((resolve) => {
        resolveExit = resolve;
      });
      const sentinelName = 'AGENTTERM_PTY_PARENT_SENTINEL';
      const previousSentinel = process.env[sentinelName];
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      process.env[sentinelName] = 'must-not-be-inherited';

      try {
        expect(isAbsolute(process.execPath)).toBe(true);

        handle = await runtime.open(
          {
            arguments: ['-e', CHILD_SCRIPT],
            environment: {
              AGENTTERM_PTY_MARKER: 'environment-ok',
              AGENTTERM_PTY_POWERSHELL: join(
                systemRoot,
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
              ),
              SystemRoot: systemRoot,
            },
            executablePath: process.execPath,
            initialSize: { columns: 80, rows: 24 },
            workingDirectory: temporaryDirectory,
          },
          (event) => {
            events.push(event);
            if (event.kind === 'exited') {
              resolveExit?.(event);
            }
          },
        );

        await waitForOutput(events, `READY:environment-ok:absent:${temporaryDirectory}:80x24`);
        await handle.write('first\r');
        await handle.write('second\r');
        await waitForOutput(events, 'INPUT:second');
        await handle.resize({ columns: 101, rows: 37 });
        await handle.write('size\r');
        await waitForOutput(events, 'SIZE:101x37');
        await handle.write('exit\r');

        const exitEvent = await withTimeout(exited, 10_000, 'ConPTY child did not exit');
        const output = joinedOutput(events);

        expect(output).toContain(`READY:environment-ok:absent:${temporaryDirectory}:80x24`);
        expect(output.indexOf('INPUT:first')).toBeLessThan(output.indexOf('INPUT:second'));
        expect(output.indexOf('INPUT:second')).toBeLessThan(output.indexOf('SIZE:101x37'));
        expect(output.indexOf('SIZE:101x37')).toBeLessThan(output.indexOf('DONE'));
        expect(events[0]?.kind).toBe('started');
        expect(events.at(-1)?.kind).toBe('exited');
        expect(events.some((event) => event.kind === 'failed')).toBe(false);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
        expect(exitEvent).toMatchObject({ exitCode: 23, kind: 'exited' });

        await handle.dispose();
        await handle.dispose();
        await handle.terminate();
      } finally {
        if (previousSentinel === undefined) {
          delete process.env[sentinelName];
        } else {
          process.env[sentinelName] = previousSentinel;
        }
        await handle?.dispose();
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'terminates a live child idempotently without leaking its ConPTY resources',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY terminate ')),
      );
      const runtime = new WindowsConPtyRuntime();
      const events: PtyRuntimeEvent[] = [];
      let handle: PtyHandle | undefined;

      try {
        handle = await runtime.open(
          {
            arguments: [
              '-e',
              "process.stdout.write('WAITING\\n'); setTimeout(() => process.exit(92), 8000);",
            ],
            environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
            executablePath: process.execPath,
            initialSize: { columns: 80, rows: 24 },
            workingDirectory: temporaryDirectory,
          },
          (event) => events.push(event),
        );
        await waitForOutput(events, 'WAITING');

        await Promise.all([handle.terminate(), handle.terminate(), handle.dispose()]);
        await handle.dispose();

        await waitForEvent(events, 'exited');
        expect(events.filter((event) => event.kind === 'exited')).toHaveLength(1);
        expect(events.some((event) => event.kind === 'failed')).toBe(false);
      } finally {
        await handle?.dispose();
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'can terminate immediately before a silent child produces output',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY immediate terminate ')),
      );
      const runtime = new WindowsConPtyRuntime();
      const events: PtyRuntimeEvent[] = [];
      let handle: PtyHandle | undefined;

      try {
        handle = await runtime.open(
          {
            arguments: ['-e', 'setTimeout(() => process.exit(93), 8000);'],
            environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
            executablePath: process.execPath,
            initialSize: { columns: 80, rows: 24 },
            workingDirectory: temporaryDirectory,
          },
          (event) => events.push(event),
        );

        await withTimeout(
          Promise.all([handle.terminate(), handle.dispose()]),
          10_000,
          'Immediate ConPTY termination did not complete',
        );

        expect(events[0]?.kind).toBe('started');
        expect(events.at(-1)?.kind).toBe('exited');
        expect(events.filter((event) => event.kind === 'exited')).toHaveLength(1);
        expect(events.some((event) => event.kind === 'failed')).toBe(false);
        expect(events.find((event) => event.kind === 'exited')).not.toMatchObject({
          exitCode: 93,
        });
      } finally {
        await handle?.dispose();
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'delivers resize and input before a silent child produces its first output',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY early input ')),
      );
      const runtime = new WindowsConPtyRuntime();
      const events: PtyRuntimeEvent[] = [];
      let handle: PtyHandle | undefined;
      let resolveExit: ((event: Extract<PtyRuntimeEvent, { kind: 'exited' }>) => void) | undefined;
      const exited = new Promise<Extract<PtyRuntimeEvent, { kind: 'exited' }>>((resolve) => {
        resolveExit = resolve;
      });
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';

      try {
        handle = await runtime.open(
          {
            arguments: ['-e', SILENT_INPUT_SCRIPT],
            environment: {
              AGENTTERM_PTY_POWERSHELL: join(
                systemRoot,
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
              ),
              SystemRoot: systemRoot,
            },
            executablePath: process.execPath,
            initialSize: { columns: 80, rows: 24 },
            workingDirectory: temporaryDirectory,
          },
          (event) => {
            events.push(event);
            if (event.kind === 'exited') {
              resolveExit?.(event);
            }
          },
        );

        await handle.resize({ columns: 111, rows: 39 });
        await handle.write('ping\r');

        const exitEvent = await withTimeout(
          exited,
          10_000,
          'Silent ConPTY child did not receive early input',
        );
        expect(joinedOutput(events)).toContain('EARLY-SIZE:111x39');
        expect(joinedOutput(events)).toContain('EARLY-INPUT:ping');
        expect(exitEvent).toMatchObject({ exitCode: 24, kind: 'exited' });
      } finally {
        await handle?.dispose();
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'terminates an attached descendant with the owned ConPTY session',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY descendant ')),
      );
      const runtime = new WindowsConPtyRuntime();
      const events: PtyRuntimeEvent[] = [];
      let descendantPid: number | undefined;
      let handle: PtyHandle | undefined;

      try {
        handle = await runtime.open(
          {
            arguments: ['-e', DESCENDANT_SCRIPT],
            environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
            executablePath: process.execPath,
            initialSize: { columns: 80, rows: 24 },
            workingDirectory: temporaryDirectory,
          },
          (event) => events.push(event),
        );

        await waitForOutput(events, 'DESCENDANT:');
        const match = /DESCENDANT:(\d+)/u.exec(joinedOutput(events));
        descendantPid = Number.parseInt(match?.[1] ?? '', 10);
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        await handle.terminate();
        await waitForProcessExit(descendantPid);

        expect(events.at(-1)?.kind).toBe('exited');
        expect(events.some((event) => event.kind === 'failed')).toBe(false);
      } finally {
        await handle?.dispose();
        if (descendantPid !== undefined) {
          await waitForProcessExit(descendantPid, 10_000);
        }
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'survives immediate input and resize races against fast silent exits',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY fast exit ')),
      );
      const runtime = new WindowsConPtyRuntime();
      const sessions: Array<{
        events: PtyRuntimeEvent[];
        exited: Promise<void>;
        handle: PtyHandle | undefined;
      }> = [];

      try {
        for (let index = 0; index < 6; index += 1) {
          const events: PtyRuntimeEvent[] = [];
          let resolveExit: (() => void) | undefined;
          const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
          });
          const session = { events, exited, handle: undefined as PtyHandle | undefined };
          sessions.push(session);

          session.handle = await runtime.open(
            {
              arguments: ['-e', 'process.exit(0);'],
              environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
              executablePath: process.execPath,
              initialSize: { columns: 80, rows: 24 },
              workingDirectory: temporaryDirectory,
            },
            (event) => {
              events.push(event);
              if (event.kind === 'exited') {
                resolveExit?.();
              }
            },
          );

          const attempts = await Promise.allSettled([
            session.handle.resize({ columns: 81 + index, rows: 25 }),
            session.handle.write('input-racing-with-exit\r'),
          ]);
          for (const attempt of attempts) {
            if (attempt.status === 'rejected') {
              expect(attempt.reason).toBeInstanceOf(PtyRuntimeError);
              expect(attempt.reason).toMatchObject({
                reason: expect.stringMatching(/^(NOT_RUNNING|RUNTIME_FAILURE)$/u),
              });
            }
          }

          await withTimeout(
            session.exited,
            5_000,
            `Fast ConPTY child ${index} lost its exit event`,
          );
          await session.handle.dispose();
        }

        for (const session of sessions) {
          expect(session.events[0]?.kind).toBe('started');
          expect(session.events.at(-1)?.kind).toBe('exited');
          expect(session.events.filter((event) => event.kind === 'exited')).toHaveLength(1);
          expect(session.events.some((event) => event.kind === 'failed')).toBe(false);
          expect(session.events.map((event) => event.sequence)).toEqual(
            session.events.map((_, index) => index + 1),
          );
        }
      } finally {
        await withTimeout(
          Promise.all(sessions.map((session) => session.handle?.dispose())),
          10_000,
          'Fast-exit ConPTY cleanup did not settle',
        );
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'win32')(
    'contains asynchronous native spawn failure inside the owned host process',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY failed spawn ')),
      );
      const invalidExecutable = join(temporaryDirectory, 'not-a-real-executable.exe');
      writeFileSync(invalidExecutable, 'not a Windows executable');
      const existingHostProcessIds = new Set(listHostedPtyProcessIds());
      const events: PtyRuntimeEvent[] = [];
      let handle: PtyHandle | undefined;
      let resolveExit: (() => void) | undefined;
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      try {
        handle = await new WindowsConPtyRuntime().open(
          {
            arguments: [],
            environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
            executablePath: invalidExecutable,
            initialSize: { columns: 80, rows: 24 },
            workingDirectory: temporaryDirectory,
          },
          (event) => {
            events.push(event);
            if (event.kind === 'exited') resolveExit?.();
          },
        );

        await withTimeout(exited, 10_000, 'Failed native ConPTY launch did not settle');
        await handle.dispose();
        await handle.dispose();

        expect(events).toEqual([
          { kind: 'started', sequence: 1 },
          { kind: 'failed', operation: 'spawn', reason: 'RUNTIME_FAILURE', sequence: 2 },
          { exitCode: -1, kind: 'exited', sequence: 3 },
        ]);
        expect(new Set(listHostedPtyProcessIds())).toEqual(existingHostProcessIds);
      } finally {
        await handle?.dispose();
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'releases the terminal tree when its runtime parent disconnects unexpectedly',
    async () => {
      const infrastructureSourceDirectory = dirname(fileURLToPath(import.meta.url));
      const fixturePath = resolve(
        infrastructureSourceDirectory,
        'test-fixtures/pty-parent-disconnect-smoke.cjs',
      );
      const hostModulePath = resolve(infrastructureSourceDirectory, 'pty/windows-conpty-host.cjs');
      const workingDirectory = realpathSync.native(tmpdir());
      const result = await executeDisconnectFixture(fixturePath, hostModulePath, workingDirectory);

      await waitForProcessExit(result.hostProcessId);
      await waitForProcessExit(result.targetProcessId);
      expect(countChildProcesses(result.hostProcessId)).toBe(0);
    },
    20_000,
  );

  it.runIf(process.platform === 'win32')(
    'releases each native ConPTY host after a natural child exit',
    async () => {
      const temporaryDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm PTY native cleanup ')),
      );
      const baselineHandleCount = countCurrentProcessHandles();

      try {
        for (let index = 0; index < 3; index += 1) {
          const runtime = new WindowsConPtyRuntime();
          const events: PtyRuntimeEvent[] = [];
          const existingHostProcessIds = new Set(listHostedPtyProcessIds());
          let handle: PtyHandle | undefined;
          let hostAliveAtExit: boolean | undefined;
          let hostProcessId: number | undefined;
          let resolveExit: (() => void) | undefined;
          const exited = new Promise<void>((resolve) => {
            resolveExit = resolve;
          });

          try {
            handle = await runtime.open(
              {
                arguments: [
                  '-e',
                  "if (process.stdin.isTTY) process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('CLEANUP_READY\\n'); process.stdin.once('data', () => process.exit(0));",
                ],
                environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
                executablePath: process.execPath,
                initialSize: { columns: 80, rows: 24 },
                workingDirectory: temporaryDirectory,
              },
              (event) => {
                events.push(event);
                if (event.kind === 'exited') {
                  hostAliveAtExit =
                    hostProcessId === undefined ? undefined : isProcessAlive(hostProcessId);
                  resolveExit?.();
                }
              },
            );
            await waitForOutput(events, 'CLEANUP_READY');
            hostProcessId = await waitForHostedPtyProcess(existingHostProcessIds);
            await handle.write('exit\r');
            await withTimeout(exited, 5_000, `Natural ConPTY child ${index} did not exit`);
            expect(hostAliveAtExit).toBe(false);
            await waitForProcessExit(hostProcessId);
            expect(countChildProcesses(hostProcessId)).toBe(0);
          } finally {
            await handle?.dispose();
          }
        }

        for (let index = 0; index < 3; index += 1) {
          const runtime = new WindowsConPtyRuntime();
          const events: PtyRuntimeEvent[] = [];
          const existingHostProcessIds = new Set(listHostedPtyProcessIds());
          let handle: PtyHandle | undefined;
          let hostAliveAtExit: boolean | undefined;
          let hostProcessId: number | undefined;

          try {
            handle = await runtime.open(
              {
                arguments: [
                  '-e',
                  "process.stdout.write('TERMINATE_READY\\n'); setTimeout(() => process.exit(99), 8000);",
                ],
                environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
                executablePath: process.execPath,
                initialSize: { columns: 80, rows: 24 },
                workingDirectory: temporaryDirectory,
              },
              (event) => {
                events.push(event);
                if (event.kind === 'exited') {
                  hostAliveAtExit =
                    hostProcessId === undefined ? undefined : isProcessAlive(hostProcessId);
                }
              },
            );
            await waitForOutput(events, 'TERMINATE_READY');
            hostProcessId = await waitForHostedPtyProcess(existingHostProcessIds);
            await handle.terminate();
            expect(hostAliveAtExit).toBe(false);
            expect(isProcessAlive(hostProcessId)).toBe(false);
            expect(countChildProcesses(hostProcessId)).toBe(0);
          } finally {
            await handle?.dispose();
          }
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        expect(countCurrentProcessHandles()).toBeLessThanOrEqual(baselineHandleCount + 2);
      } finally {
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    },
    30_000,
  );
});

function joinedOutput(events: readonly PtyRuntimeEvent[]): string {
  return events
    .filter(
      (event): event is Extract<PtyRuntimeEvent, { kind: 'output' }> => event.kind === 'output',
    )
    .map((event) => event.data)
    .join('');
}

async function waitForOutput(events: readonly PtyRuntimeEvent[], expected: string): Promise<void> {
  await waitUntil(
    () => joinedOutput(events).includes(expected),
    () => `Missing PTY output: ${expected}. Received: ${JSON.stringify(joinedOutput(events))}`,
  );
}

async function waitForEvent(events: readonly PtyRuntimeEvent[], kind: PtyRuntimeEvent['kind']) {
  await waitUntil(
    () => events.some((event) => event.kind === kind),
    () => `Missing PTY event: ${kind}`,
  );
}

async function waitUntil(predicate: () => boolean, message: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message());
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(processId: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`ConPTY descendant ${processId} is still running.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function runProcessQuery(command: string): string {
  const powershellPath = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return execFileSync(
    powershellPath,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  );
}

function countCurrentProcessHandles(): number {
  const output = runProcessQuery(`(Get-Process -Id ${process.pid}).HandleCount`);
  return Number.parseInt(output.trim(), 10);
}

function listHostedPtyProcessIds(): number[] {
  const output = runProcessQuery(
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*windows-conpty-host.cjs*' } | Select-Object -ExpandProperty ProcessId) -join ','`,
  ).trim();
  if (output === '') return [];
  return output.split(',').map((value) => Number.parseInt(value, 10));
}

async function waitForHostedPtyProcess(existingProcessIds: ReadonlySet<number>): Promise<number> {
  let processIds: number[] = [];
  await waitUntil(
    () => {
      processIds = listHostedPtyProcessIds().filter(
        (processId) => !existingProcessIds.has(processId),
      );
      return processIds.length === 1;
    },
    () => `Expected one new owned PTY host process, received: ${processIds.join(', ')}`,
  );
  return processIds[0] as number;
}

function countChildProcesses(parentProcessId: number): number {
  const output = runProcessQuery(
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentProcessId}").Count`,
  );
  return Number.parseInt(output.trim(), 10);
}

function executeDisconnectFixture(
  fixturePath: string,
  hostModulePath: string,
  workingDirectory: string,
): Promise<{ hostProcessId: number; targetProcessId: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [fixturePath],
      {
        cwd: workingDirectory,
        encoding: 'utf8',
        env: {
          AGENTTERM_PTY_HOST_MODULE: hostModulePath,
          AGENTTERM_PTY_TARGET_EXECUTABLE: process.execPath,
          AGENTTERM_PTY_WORKING_DIRECTORY: workingDirectory,
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          TEMP: process.env.TEMP ?? workingDirectory,
          TMP: process.env.TMP ?? workingDirectory,
        },
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`PTY disconnect fixture failed: ${stderr}`, { cause: error }));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as {
            hostProcessId?: unknown;
            targetProcessId?: unknown;
          };
          if (
            typeof parsed.hostProcessId !== 'number' ||
            !Number.isSafeInteger(parsed.hostProcessId) ||
            typeof parsed.targetProcessId !== 'number' ||
            !Number.isSafeInteger(parsed.targetProcessId)
          ) {
            throw new Error('PTY disconnect fixture returned invalid process identities.');
          }
          resolvePromise({
            hostProcessId: parsed.hostProcessId,
            targetProcessId: parsed.targetProcessId,
          });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
