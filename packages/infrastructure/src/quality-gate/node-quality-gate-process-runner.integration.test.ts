import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    'does not report terminal while a detached descendant still owns the gate job',
    async () => {
      const workingDirectory = createTemporaryDirectory('detached-descendant');
      const rootMarker = join(workingDirectory, 'root-exited.txt');
      const descendantMarker = join(workingDirectory, 'descendant-finished.txt');
      const descendantProgram = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)}, 'finished'), 500);`;
      const rootProgram = `const fs = require('node:fs'); const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { detached: true, env: {}, stdio: 'ignore', windowsHide: true }); child.unref(); fs.writeFileSync(${JSON.stringify(rootMarker)}, 'exited'); process.stdout.write('ROOT_EXITED\\n');`;

      const resultPromise = new NodeQualityGateProcessRunner().run({
        arguments: ['-e', rootProgram],
        environment: {},
        executablePath: process.execPath,
        maxOutputBytes: 16 * 1024,
        redactValues: [],
        timeoutMs: 5_000,
        workingDirectory,
      });
      await waitForPath(rootMarker);
      expect(await settlesWithin(resultPromise, 150)).toBe(false);
      const result = await resultPromise;
      const markerExistedWhenRunnerReturned = existsSync(descendantMarker);

      expect(result).toMatchObject({ exitCode: 0, kind: 'exited', truncated: false });
      expect(result.output).toContain('ROOT_EXITED');
      expect(markerExistedWhenRunnerReturned).toBe(true);
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'terminates the owned process tree after timeout',
    async () => {
      const workingDirectory = createTemporaryDirectory('timeout-tree');
      const releaseDescendant = join(workingDirectory, 'release-descendant.txt');
      const descendantMarker = join(workingDirectory, 'descendant-must-not-write.txt');
      const descendantProgram = `const fs = require('node:fs'); const release = ${JSON.stringify(releaseDescendant)}; const marker = ${JSON.stringify(descendantMarker)}; const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); fs.writeFileSync(marker, 'escaped'); } }, 10);`;
      const result = await new NodeQualityGateProcessRunner().run({
        arguments: [
          '-e',
          `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { detached: true, env: {}, stdio: 'ignore', windowsHide: true }); child.unref(); process.stdout.write('DESCENDANT:' + child.pid + '\\n'); setInterval(() => undefined, 1000);`,
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
      writeFileSync(releaseDescendant, 'release');
      await expectPathToRemainMissing(descendantMarker);
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

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Expected test path was not created: ${path}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  const marker = Symbol('not-settled');
  const winner = await Promise.race([
    promise.then(() => true),
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), milliseconds)),
  ]);
  return winner === true;
}

async function expectPathToRemainMissing(path: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      throw new Error(`Terminated quality-gate descendant wrote after settlement: ${path}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
