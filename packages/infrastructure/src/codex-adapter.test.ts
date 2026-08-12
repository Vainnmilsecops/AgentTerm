import type { ExecFileException } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentAdapterError } from '@agentterm/application';

import { CodexAdapter } from './index';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

type CommandResponse =
  | {
      readonly kind: 'success';
      readonly stderr?: string;
      readonly stdout: string;
    }
  | {
      readonly code: number | string;
      readonly kind: 'failure';
      readonly stderr?: string;
      readonly stdout?: string;
    };

const temporaryDirectories: string[] = [];
let commandResponses: CommandResponse[] = [];

function createTemporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `agentterm-codex-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function createExecutable(directory: string, name = executableName('codex')): string {
  mkdirSync(directory, { recursive: true });
  const executablePath = join(directory, name);
  writeFileSync(executablePath, 'test executable');
  chmodSync(executablePath, 0o755);
  return realpathSync.native(executablePath);
}

function createNpmCodexInstallation(root: string): {
  readonly entrypointPath: string;
  readonly nodeExecutablePath: string;
  readonly shimPath: string;
} {
  const packageRoot = join(root, 'node_modules', '@openai', 'codex');
  const binDirectory = join(packageRoot, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  const shimPath = join(root, 'codex.cmd');
  const entrypointPath = join(binDirectory, 'codex.js');
  writeFileSync(shimPath, '@echo off\r\n');
  writeFileSync(entrypointPath, '#!/usr/bin/env node\n');
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ bin: { codex: 'bin/codex.js' }, name: '@openai/codex', version: '0.147.0' }),
  );
  const nodeExecutablePath = createExecutable(root, executableName('node'));
  return {
    entrypointPath: realpathSync.native(entrypointPath),
    nodeExecutablePath,
    shimPath: realpathSync.native(shimPath),
  };
}

function executableName(bareName: string): string {
  return process.platform === 'win32' ? `${bareName}.exe` : bareName;
}

function enqueue(...responses: CommandResponse[]): void {
  commandResponses.push(...responses);
}

function successful(stdout: string): CommandResponse {
  return { kind: 'success', stdout };
}

function failed(code: number | string, stdout = ''): CommandResponse {
  return { code, kind: 'failure', stdout };
}

function installExecFileDouble(): void {
  execFileMock.mockImplementation(
    (
      _executable: string,
      _arguments: readonly string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      const response = commandResponses.shift();

      if (response === undefined) {
        throw new Error('Unexpected Codex process probe.');
      }

      queueMicrotask(() => {
        if (response.kind === 'success') {
          callback(null, response.stdout, response.stderr ?? '');
          return;
        }

        const error = Object.assign(new Error('Codex probe failed.'), { code: response.code });
        callback(error, response.stdout ?? '', response.stderr ?? '');
      });

      return undefined;
    },
  );
}

function expectAdapterFailure(error: unknown, reason: AgentAdapterError['reason']): void {
  expect(error).toBeInstanceOf(AgentAdapterError);
  expect(error).toMatchObject({ name: 'AgentAdapterError', reason });
}

beforeEach(() => {
  commandResponses = [];
  execFileMock.mockReset();
  installExecFileDouble();
});

afterEach(() => {
  vi.unstubAllEnvs();

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('CodexAdapter inspection', () => {
  it('reports parsed version and resume capability for an available Codex executable', async () => {
    const root = createTemporaryDirectory('available');
    const executablePath = createExecutable(join(root, 'Codex bin'));
    enqueue(successful('codex-cli 0.147.0\r\n'), successful('Resume a previous session\r\n'));

    const availability = await new CodexAdapter(executablePath).inspect();

    expect(availability).toEqual({
      capabilities: { resume: true },
      executablePath,
      kind: 'available',
      version: { major: 0, minor: 147, patch: 0, raw: 'codex-cli 0.147.0' },
    });
  });

  it('reports resume as unsupported when the safe capability probe exits nonzero', async () => {
    const executablePath = createExecutable(createTemporaryDirectory('no-resume'));
    enqueue(successful('codex-cli 0.147.0\n'), failed(2));

    await expect(new CodexAdapter(executablePath).inspect()).resolves.toMatchObject({
      capabilities: { resume: false },
      kind: 'available',
    });
  });

  it('reports a missing configured absolute executable without starting a process', async () => {
    const missingPath = join(createTemporaryDirectory('missing-absolute'), executableName('codex'));

    await expect(new CodexAdapter(missingPath).inspect()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'EXECUTABLE_NOT_FOUND',
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('reports a missing bare executable without using the current directory as PATH', async () => {
    const root = createTemporaryDirectory('missing-bare');
    const originalWorkingDirectory = process.cwd();
    const workingDirectory = join(root, 'current directory');
    mkdirSync(workingDirectory);
    createExecutable(workingDirectory);
    vi.stubEnv('PATH', `.${delimiter}relative-bin`);

    try {
      process.chdir(workingDirectory);

      await expect(new CodexAdapter().inspect()).resolves.toEqual({
        kind: 'unavailable',
        reason: 'EXECUTABLE_NOT_FOUND',
      });
    } finally {
      process.chdir(originalWorkingDirectory);
    }

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('skips relative PATH entries and resolves the first executable in an absolute PATH entry', async () => {
    const root = createTemporaryDirectory('trusted-path');
    const originalWorkingDirectory = process.cwd();
    const workingDirectory = join(root, 'current directory');
    const trustedBin = join(root, 'trusted bin');
    mkdirSync(workingDirectory);
    createExecutable(workingDirectory);
    const trustedExecutable = createExecutable(trustedBin);
    vi.stubEnv('PATH', `.${delimiter}relative-bin${delimiter}"${trustedBin}"`);
    enqueue(successful('codex-cli 0.147.0\n'), successful('resume help\n'));

    try {
      process.chdir(workingDirectory);
      await expect(new CodexAdapter().inspect()).resolves.toMatchObject({
        executablePath: trustedExecutable,
        kind: 'available',
      });
    } finally {
      process.chdir(originalWorkingDirectory);
    }
  });

  it.runIf(process.platform === 'win32')(
    'detects an official npm installation without executing its command shim through a shell',
    async () => {
      const root = createTemporaryDirectory('npm-installation');
      const installation = createNpmCodexInstallation(root);
      vi.stubEnv('PATH', root);
      enqueue(successful('codex-cli 0.147.0\n'), successful('resume help\n'));

      const availability = await new CodexAdapter().inspect();

      expect(availability).toMatchObject({
        executablePath: installation.entrypointPath,
        kind: 'available',
      });
      expect(execFileMock).toHaveBeenNthCalledWith(
        1,
        installation.nodeExecutablePath,
        [installation.entrypointPath, '--version'],
        expect.objectContaining({ shell: false }),
        expect.any(Function),
      );
    },
  );

  it('keeps an executable available when its successful version label is not parseable', async () => {
    const executablePath = createExecutable(createTemporaryDirectory('unknown-version'));
    enqueue(successful('Codex version latest\n'), successful('resume help\n'));

    await expect(new CodexAdapter(executablePath).inspect()).resolves.toEqual({
      capabilities: { resume: true },
      executablePath,
      kind: 'available',
    });
  });

  it.each([
    ['nonzero exit', failed(1, 'codex-cli 0.147.0\n')],
    ['operational failure', failed('EACCES')],
  ])('reports inspection failure for %s from the version probe', async (_label, response) => {
    const executablePath = createExecutable(createTemporaryDirectory('bad-version'));
    enqueue(response);

    await expect(new CodexAdapter(executablePath).inspect()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INSPECTION_FAILED',
    });
  });

  it('uses structured version and capability probes with no shell', async () => {
    const executablePath = createExecutable(createTemporaryDirectory('structured-probe'));
    enqueue(successful('codex-cli 0.147.0\n'), successful('resume help\n'));

    await new CodexAdapter(executablePath).inspect();

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      executablePath,
      ['--version'],
      expect.objectContaining({ shell: false, windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      executablePath,
      ['resume', '--help'],
      expect.objectContaining({ shell: false, windowsHide: true }),
      expect.any(Function),
    );

    const probeOptions = execFileMock.mock.calls[0]?.[2] as {
      env?: NodeJS.ProcessEnv;
      maxBuffer?: number;
      timeout?: number;
    };
    expect(probeOptions).toMatchObject({ maxBuffer: 64 * 1024, timeout: 5_000 });
    expect(probeOptions.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(probeOptions.env).not.toHaveProperty('CODEX_ACCESS_TOKEN');
    expect(probeOptions.env).not.toHaveProperty('NODE_OPTIONS');
  });
});

describe('CodexAdapter launch commands', () => {
  it('builds an interactive command for the canonical Unicode working directory and exact caller environment', async () => {
    const root = createTemporaryDirectory('launch');
    const executablePath = createExecutable(join(root, 'Codex CLI'));
    const workingDirectory = join(root, 'Task Worktree thử nghiệm');
    mkdirSync(workingDirectory);
    const canonicalWorkingDirectory = realpathSync.native(workingDirectory);
    const environment = Object.freeze({
      APPDATA: 'C:\\Users\\tester\\AppData\\Roaming',
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TERM: 'xterm-256color',
      USERPROFILE: 'C:\\Users\\tester',
    });
    vi.stubEnv('OPENAI_API_KEY', 'must-not-be-forwarded');
    vi.stubEnv('CODEX_ACCESS_TOKEN', 'must-not-be-forwarded');
    vi.stubEnv('UNRELATED_AMBIENT_VALUE', 'must-not-be-forwarded');

    const command = await new CodexAdapter(executablePath).buildLaunchCommand({
      environment,
      workingDirectory,
    });

    expect(command).toEqual({
      arguments: ['--cd', canonicalWorkingDirectory],
      environment,
      executablePath,
      workingDirectory: canonicalWorkingDirectory,
    });
    expect(command.environment).not.toHaveProperty('OPENAI_API_KEY');
    expect(command.environment).not.toHaveProperty('CODEX_ACCESS_TOKEN');
    expect(command.environment).not.toHaveProperty('UNRELATED_AMBIENT_VALUE');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects a missing executable with a typed adapter failure', async () => {
    const missingExecutable = join(
      createTemporaryDirectory('launch-missing-executable'),
      executableName('codex'),
    );

    const error = await new CodexAdapter(missingExecutable)
      .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'EXECUTABLE_NOT_FOUND');
  });

  it('rejects a directory used as the executable with a typed adapter failure', async () => {
    const executableDirectory = createTemporaryDirectory('directory-executable');

    const error = await new CodexAdapter(executableDirectory)
      .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'EXECUTABLE_NOT_FOUND');
  });

  it('rejects a relative working directory with a typed adapter failure', async () => {
    const executablePath = createExecutable(createTemporaryDirectory('invalid-cwd'));

    const error = await new CodexAdapter(executablePath)
      .buildLaunchCommand({ environment: {}, workingDirectory: 'relative-worktree' })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
  });

  it('rejects a missing working directory with a typed adapter failure', async () => {
    const root = createTemporaryDirectory('missing-cwd');
    const executablePath = createExecutable(join(root, 'bin'));
    const missingWorkingDirectory = join(root, 'missing Task Worktree');

    const error = await new CodexAdapter(executablePath)
      .buildLaunchCommand({ environment: {}, workingDirectory: missingWorkingDirectory })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
  });

  it('rejects a file used as the working directory', async () => {
    const root = createTemporaryDirectory('file-cwd');
    const executablePath = createExecutable(join(root, 'bin'));
    const filePath = join(root, 'not-a-worktree.txt');
    writeFileSync(filePath, 'not a directory');

    const error = await new CodexAdapter(executablePath)
      .buildLaunchCommand({ environment: {}, workingDirectory: filePath })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
  });

  it.each([
    ['an array', []],
    ['an inherited object', Object.create({ PATH: 'inherited' })],
    ['an empty name', { '': 'value' }],
    ['a name containing equals', { 'BAD=NAME': 'value' }],
    ['a name containing NUL', { 'BAD\0NAME': 'value' }],
    ['a value containing NUL', { SAFE_NAME: 'bad\0value' }],
    ['case-insensitively duplicated names', { Path: 'first', PATH: 'second' }],
  ])('rejects %s in the exact launch environment', async (_label, invalidEnvironment) => {
    const executablePath = createExecutable(createTemporaryDirectory('invalid-environment'));

    const error = await new CodexAdapter(executablePath)
      .buildLaunchCommand({
        environment: invalidEnvironment as Readonly<Record<string, string>>,
        workingDirectory: process.cwd(),
      })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
  });

  it('sanitizes an environment object that throws during validation', async () => {
    const executablePath = createExecutable(createTemporaryDirectory('throwing-environment'));
    const environment = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('ambient-secret-from-environment');
        },
      },
    ) as Readonly<Record<string, string>>;

    const error = await new CodexAdapter(executablePath)
      .buildLaunchCommand({ environment, workingDirectory: process.cwd() })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
    expect(String(error)).not.toContain('ambient-secret-from-environment');
  });

  it.runIf(process.platform === 'win32')(
    'launches an official npm installation through Node instead of executing its command shim',
    async () => {
      const root = createTemporaryDirectory('npm-launch');
      const installation = createNpmCodexInstallation(root);

      const command = await new CodexAdapter(installation.shimPath).buildLaunchCommand({
        environment: { SystemRoot: 'C:\\Windows' },
        workingDirectory: process.cwd(),
      });

      expect(command).toEqual({
        arguments: [installation.entrypointPath, '--cd', realpathSync.native(process.cwd())],
        environment: { SystemRoot: 'C:\\Windows' },
        executablePath: installation.nodeExecutablePath,
        workingDirectory: realpathSync.native(process.cwd()),
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects Node injection variables for an npm-backed Codex launch',
    async () => {
      const root = createTemporaryDirectory('npm-node-injection');
      const installation = createNpmCodexInstallation(root);

      for (const environment of [
        { NODE_OPTIONS: '--require malicious.js' },
        { Node_Path: 'C:\\untrusted-modules' },
      ]) {
        const error = await new CodexAdapter(installation.shimPath)
          .buildLaunchCommand({ environment, workingDirectory: process.cwd() })
          .catch((failure: unknown) => failure);

        expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an unverified command shim instead of executing it through a shell',
    async () => {
      const directory = createTemporaryDirectory('unverified-command-wrapper');
      const wrapperPath = join(directory, 'codex.cmd');
      writeFileSync(wrapperPath, '@exit /b 0');

      const error = await new CodexAdapter(wrapperPath)
        .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
        .catch((failure: unknown) => failure);

      expectAdapterFailure(error, 'INSPECTION_FAILED');
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );
});
