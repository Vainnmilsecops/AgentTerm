import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeQualityGateProcessRunner } from '../index';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(label: string): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), `agentterm-gate-${label}-`)));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('NodeQualityGateProcessRunner with real processes', () => {
  it('runs structured arguments in the exact Unicode working directory and captures a nonzero exit', async () => {
    const workingDirectory = createTemporaryDirectory('thử-nghiệm');
    const injectionMarker = join(workingDirectory, 'must-not-exist.txt');
    const literalArgument = `literal & echo unsafe > "${injectionMarker}"`;
    const ambientName = 'AGENTTERM_GATE_AMBIENT_SENTINEL';
    const previousAmbient = process.env[ambientName];
    process.env[ambientName] = 'must-not-be-inherited';

    try {
      const result = await new NodeQualityGateProcessRunner().run({
        arguments: [
          '-e',
          `process.stdout.write('OUT:' + process.cwd() + ':' + process.argv[1] + ':' + (process.env.AGENTTERM_GATE_MARKER ?? 'missing') + ':' + (process.env.${ambientName} ?? 'absent') + '\\n'); process.stderr.write('ERR:secret-value:Tiếng Việt\\n'); process.exitCode = 7;`,
          literalArgument,
        ],
        environment: { AGENTTERM_GATE_MARKER: 'exact-environment' },
        executablePath: process.execPath,
        maxOutputBytes: 64 * 1024,
        redactValues: ['secret-value'],
        timeoutMs: 5_000,
        workingDirectory,
      });

      expect(result).toMatchObject({ exitCode: 7, kind: 'exited', truncated: false });
      expect(result.output).toContain(
        `OUT:${workingDirectory}:${literalArgument}:exact-environment:absent`,
      );
      expect(result.output).toContain('ERR:[REDACTED]:Tiếng Việt');
      expect(result.output).not.toContain('secret-value');
      expect(existsSync(injectionMarker)).toBe(false);
    } finally {
      if (previousAmbient === undefined) {
        delete process.env[ambientName];
      } else {
        process.env[ambientName] = previousAmbient;
      }
    }
  });

  it('bounds retained output without blocking a child that continues writing', async () => {
    const workingDirectory = createTemporaryDirectory('bounded-output');

    const result = await new NodeQualityGateProcessRunner().run({
      arguments: [
        '-e',
        `for (let index = 0; index < 512; index += 1) { process.stdout.write('Đầu-' + index + '-'.repeat(64)); process.stderr.write('ERR-' + index + '-'.repeat(64)); }`,
      ],
      environment: {},
      executablePath: process.execPath,
      maxOutputBytes: 1_024,
      redactValues: [],
      timeoutMs: 5_000,
      workingDirectory,
    });

    expect(result).toMatchObject({ exitCode: 0, kind: 'exited', truncated: true });
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(result.output).toContain('Đầu-0');
  });

  it.runIf(process.platform === 'win32')(
    'terminates the owned process tree after timeout',
    async () => {
      const workingDirectory = createTemporaryDirectory('timeout-tree');
      const result = await new NodeQualityGateProcessRunner().run({
        arguments: [
          '-e',
          `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], { env: {}, stdio: 'ignore', windowsHide: true }); process.stdout.write('DESCENDANT:' + child.pid + '\\n'); setInterval(() => undefined, 1000);`,
        ],
        environment: {},
        executablePath: process.execPath,
        maxOutputBytes: 16 * 1024,
        redactValues: [],
        timeoutMs: 300,
        workingDirectory,
      });

      expect(result).toMatchObject({ kind: 'timed-out', truncated: false });
      const descendantMatch = /DESCENDANT:(\d+)/u.exec(result.output);
      expect(descendantMatch).not.toBeNull();
      const descendantPid = Number.parseInt(descendantMatch?.[1] ?? '', 10);
      await waitForProcessExit(descendantPid);
      expect(isProcessAlive(descendantPid)).toBe(false);
    },
    15_000,
  );

  it('returns a sanitized launch error for a missing executable', async () => {
    const workingDirectory = createTemporaryDirectory('missing-executable');
    const secret = 'do-not-leak-this-launch-secret';

    const result = await new NodeQualityGateProcessRunner().run({
      arguments: [],
      environment: { SECRET: secret },
      executablePath: join(workingDirectory, 'missing.exe'),
      maxOutputBytes: 1_024,
      redactValues: [secret],
      timeoutMs: 1_000,
      workingDirectory,
    });

    expect(result).toMatchObject({ kind: 'launch-error', output: '', truncated: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

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

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isProcessAlive(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Quality-gate descendant ${processId} is still running.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
