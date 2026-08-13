import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, type TestContext } from 'vitest';

import type { AgentAdapter, PtyHandle, PtyRuntimeEvent } from '@agentterm/application';

import { ClaudeAdapter, GeminiAdapter, WindowsConPtyRuntime } from './index';

describe('installed provider adapters with real Windows ConPTY', () => {
  it.runIf(process.platform === 'win32')(
    'inspects and launches the installed Claude CLI version probe in a Unicode Task Worktree',
    async (context) =>
      verifyInstalledAdapter(context, new ClaudeAdapter(), 'claude', /Claude Code/u),
    30_000,
  );

  it.runIf(process.platform === 'win32')(
    'inspects and launches the installed Gemini CLI version probe in a Unicode Task Worktree',
    async (context) =>
      verifyInstalledAdapter(context, new GeminiAdapter(), 'gemini', /\d+\.\d+\.\d+/u),
    30_000,
  );
});

async function verifyInstalledAdapter(
  context: TestContext,
  adapter: AgentAdapter,
  expectedAgentId: string,
  outputPattern: RegExp,
): Promise<void> {
  const availability = await adapter.inspect();
  if (availability.kind !== 'available') {
    context.skip();
    return;
  }

  const workingDirectory = realpathSync.native(
    mkdtempSync(join(tmpdir(), `agentterm ${expectedAgentId} Tác vụ `)),
  );
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
    expect(adapter.identity.id).toBe(expectedAgentId);
    expect(availability.version).toMatchObject({
      major: expect.any(Number),
      minor: expect.any(Number),
      patch: expect.any(Number),
      raw: expect.any(String),
    });
    expect([[], ['SESSION_RESUME']]).toContainEqual(availability.capabilities);
    const command = await adapter.buildLaunchCommand({ environment, workingDirectory });
    expect(command.workingDirectory).toBe(workingDirectory);

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

    const exit = await withTimeout(exited, 15_000, `${expectedAgentId} version probe timed out.`);
    const output = events
      .filter(
        (event): event is Extract<PtyRuntimeEvent, { kind: 'output' }> => event.kind === 'output',
      )
      .map((event) => event.data)
      .join('');
    expect(events[0]).toEqual({ kind: 'started', sequence: 1 });
    expect(output).toMatch(outputPattern);
    expect(exit).toMatchObject({ exitCode: 0, kind: 'exited' });
    expect(events.some((event) => event.kind === 'failed')).toBe(false);
  } finally {
    await handle?.dispose();
    rmSync(workingDirectory, { force: true, recursive: true });
  }
}

function getEnvironmentVariable(name: string): string | undefined {
  const normalized = name.toUpperCase();
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === normalized)?.[1];
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
