import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PtyHandle, PtyRuntimeEvent } from '@agentterm/application';

import { CodexAdapter, WindowsConPtyRuntime } from './index';

describe('CodexAdapter with real Windows ConPTY', () => {
  it.runIf(process.platform === 'win32')(
    'inspects and launches the installed Codex CLI in the supplied Unicode Worktree directory',
    async (context) => {
      const executablePath = findInstalledCodexExecutable();

      if (executablePath === undefined) {
        context.skip();
        return;
      }

      const workingDirectory = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'agentterm Codex T\u00e1c v\u1ee5 ')),
      );
      const existingHostProcessIds = new Set(listHostedPtyProcessIds());
      const adapter = new CodexAdapter();
      const runtime = new WindowsConPtyRuntime();
      const events: PtyRuntimeEvent[] = [];
      let handle: PtyHandle | undefined;
      let resolveExit: ((event: Extract<PtyRuntimeEvent, { kind: 'exited' }>) => void) | undefined;
      const exited = new Promise<Extract<PtyRuntimeEvent, { kind: 'exited' }>>((resolve) => {
        resolveExit = resolve;
      });
      const systemRoot = getEnvironmentVariable('SYSTEMROOT') ?? 'C:\\Windows';
      const environment = {
        SystemRoot: systemRoot,
        TEMP: workingDirectory,
        TMP: workingDirectory,
        WINDIR: systemRoot,
      };

      try {
        expect(adapter.identity).toEqual({ displayName: 'Codex', id: 'codex' });
        const availability = await adapter.inspect();

        expect(availability).toMatchObject({
          capabilities: expect.any(Array),
          executablePath,
          kind: 'available',
          version: {
            major: expect.any(Number),
            minor: expect.any(Number),
            patch: expect.any(Number),
            raw: expect.stringMatching(/^codex-cli \d+\.\d+\.\d+$/u),
          },
        });

        if (availability.kind !== 'available' || availability.version === undefined) {
          throw new Error('Installed Codex CLI did not report a parseable version.');
        }
        expect([[], ['SESSION_RESUME']]).toContainEqual(availability.capabilities);

        const command = await adapter.buildLaunchCommand({ environment, workingDirectory });

        expect(command).toEqual({
          arguments: ['--cd', workingDirectory],
          environment,
          executablePath,
          workingDirectory,
        });

        handle = await runtime.open(
          {
            ...command,
            arguments: [...command.arguments, '--version'],
            initialSize: { columns: 100, rows: 30 },
          },
          (event) => {
            events.push(event);

            if (event.kind === 'exited') {
              resolveExit?.(event);
            }
          },
        );

        const exitEvent = await withTimeout(
          exited,
          15_000,
          'Installed Codex CLI did not exit after its version probe.',
        );
        const output = joinedOutput(events);

        expect(events[0]).toEqual({ kind: 'started', sequence: 1 });
        expect(output).toMatch(/codex-cli \d+\.\d+\.\d+/u);
        expect(output).toContain(availability.version.raw);
        expect(events.some((event) => event.kind === 'failed')).toBe(false);
        expect(exitEvent).toMatchObject({ exitCode: 0, kind: 'exited' });
        expect(events.at(-1)).toBe(exitEvent);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      } finally {
        try {
          await handle?.dispose();
          await waitForOwnedHostsToExit(existingHostProcessIds);
        } finally {
          rmSync(workingDirectory, { force: true, recursive: true });
        }
      }
    },
    30_000,
  );
});

function findInstalledCodexExecutable(): string | undefined {
  const pathValue = getEnvironmentVariable('PATH');

  if (pathValue === undefined) {
    return undefined;
  }

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = removeSurroundingQuotes(rawDirectory);

    if (directory.length === 0 || !isAbsolute(directory)) {
      continue;
    }

    try {
      const candidate = realpathSync.native(join(directory, 'codex.exe'));

      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Continue searching the remaining absolute PATH entries.
    }
  }

  return undefined;
}

function getEnvironmentVariable(name: string): string | undefined {
  const normalizedName = name.toUpperCase();

  for (const [environmentName, value] of Object.entries(process.env)) {
    if (environmentName.toUpperCase() === normalizedName) {
      return value;
    }
  }

  return undefined;
}

function removeSurroundingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function joinedOutput(events: readonly PtyRuntimeEvent[]): string {
  return events
    .filter(
      (event): event is Extract<PtyRuntimeEvent, { kind: 'output' }> => event.kind === 'output',
    )
    .map((event) => event.data)
    .join('');
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

function listHostedPtyProcessIds(): number[] {
  const powershellPath = join(
    getEnvironmentVariable('SYSTEMROOT') ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const output = execFileSync(
    powershellPath,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*windows-conpty-host.cjs*' } | Select-Object -ExpandProperty ProcessId) -join ','`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();

  return output === '' ? [] : output.split(',').map((value) => Number.parseInt(value, 10));
}

async function waitForOwnedHostsToExit(existingProcessIds: ReadonlySet<number>): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (true) {
    const remainingProcessIds = listHostedPtyProcessIds().filter(
      (processId) => !existingProcessIds.has(processId),
    );

    if (remainingProcessIds.length === 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Codex PTY hosts are still running: ${remainingProcessIds.join(', ')}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
