import type { ExecFileException } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentAdapterError } from '@agentterm/application';

import { ClaudeAdapter, GeminiAdapter } from './index';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

type CommandResponse =
  | { readonly kind: 'success'; readonly stdout: string }
  | { readonly code: number | string; readonly kind: 'failure'; readonly stdout?: string };

const temporaryDirectories: string[] = [];
let commandResponses: CommandResponse[] = [];

function createTemporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `agentterm-provider-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function createExecutable(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const executablePath = join(directory, name);
  writeFileSync(executablePath, 'test executable');
  chmodSync(executablePath, 0o755);
  return realpathSync.native(executablePath);
}

function executableName(bareName: string): string {
  return process.platform === 'win32' ? `${bareName}.exe` : bareName;
}

function createClaudeNpmInstallation(root: string) {
  const packageRoot = join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  const shimPath = join(root, 'claude.cmd');
  const executablePath = createExecutable(join(packageRoot, 'bin'), 'claude.exe');
  writeFileSync(shimPath, '@echo off\r\n');
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      bin: { claude: 'bin/claude.exe' },
      name: '@anthropic-ai/claude-code',
      version: '2.1.220',
    }),
  );
  return { executablePath, shimPath: realpathSync.native(shimPath) };
}

function createGeminiNpmInstallation(root: string) {
  const packageRoot = join(root, 'node_modules', '@google', 'gemini-cli');
  const bundleDirectory = join(packageRoot, 'bundle');
  mkdirSync(bundleDirectory, { recursive: true });
  const shimPath = join(root, 'gemini.cmd');
  const entrypointPath = join(bundleDirectory, 'gemini.js');
  writeFileSync(shimPath, '@echo off\r\n');
  writeFileSync(entrypointPath, '#!/usr/bin/env node\n');
  chmodSync(entrypointPath, 0o755);
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      bin: { gemini: 'bundle/gemini.js' },
      name: '@google/gemini-cli',
      version: '0.55.1',
    }),
  );
  const nodeExecutablePath = createExecutable(root, executableName('node'));
  return {
    entrypointPath: realpathSync.native(entrypointPath),
    nodeExecutablePath,
    shimPath: realpathSync.native(shimPath),
  };
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

function expectAdapterFailure(error: unknown, reason: AgentAdapterError['reason']): void {
  expect(error).toBeInstanceOf(AgentAdapterError);
  expect(error).toMatchObject({ name: 'AgentAdapterError', reason });
}

beforeEach(() => {
  commandResponses = [];
  execFileMock.mockReset();
  execFileMock.mockImplementation(
    (
      _executable: string,
      _arguments: readonly string[],
      _options: unknown,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) => {
      const response = commandResponses.shift();
      if (response === undefined) {
        throw new Error('Unexpected agent CLI probe.');
      }
      queueMicrotask(() => {
        if (response.kind === 'success') {
          callback(null, response.stdout, '');
          return;
        }
        callback(
          Object.assign(new Error('Agent CLI probe failed.'), { code: response.code }),
          response.stdout ?? '',
          '',
        );
      });
      return undefined;
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('ClaudeAdapter', () => {
  it('detects version and only reports resume when the installed CLI advertises it', async () => {
    const executablePath = createExecutable(
      createTemporaryDirectory('claude-inspect'),
      executableName('claude'),
    );
    enqueue(
      successful('2.1.220 (Claude Code)\r\n'),
      successful('  -r, --resume [value]  Resume a conversation\n'),
    );

    const adapter = new ClaudeAdapter(executablePath);

    await expect(adapter.inspect()).resolves.toEqual({
      capabilities: ['SESSION_RESUME'],
      executablePath,
      kind: 'available',
      version: { major: 2, minor: 1, patch: 220, raw: '2.1.220 (Claude Code)' },
    });
    expect(adapter.identity).toEqual({ displayName: 'Claude', id: 'claude' });
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      executablePath,
      ['--version'],
      expect.objectContaining({ shell: false, timeout: 5_000, windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      executablePath,
      ['--help'],
      expect.objectContaining({ shell: false }),
      expect.any(Function),
    );
    const probeEnvironment = (execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env;
    expect(probeEnvironment).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(probeEnvironment).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(probeEnvironment).not.toHaveProperty('NODE_OPTIONS');
  });

  it('builds an interactive command in the canonical Worktree with the exact approved environment', async () => {
    const root = createTemporaryDirectory('claude-launch');
    const executablePath = createExecutable(join(root, 'bin'), executableName('claude'));
    const workingDirectory = join(root, 'Claude Tác vụ');
    mkdirSync(workingDirectory);
    const environment = Object.freeze({
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\tester',
    });

    await expect(
      new ClaudeAdapter(executablePath).buildLaunchCommand({ environment, workingDirectory }),
    ).resolves.toEqual({
      arguments: [],
      environment,
      executablePath,
      workingDirectory: realpathSync.native(workingDirectory),
    });
  });

  it.runIf(process.platform === 'win32')(
    'resolves the official npm native binary without executing its command shim',
    async () => {
      const installation = createClaudeNpmInstallation(createTemporaryDirectory('claude-npm'));
      enqueue(successful('2.1.220 (Claude Code)\n'), successful('--resume [value]\n'));

      const availability = await new ClaudeAdapter(installation.shimPath).inspect();

      expect(availability).toMatchObject({
        executablePath: installation.executablePath,
        kind: 'available',
      });
      expect(execFileMock).toHaveBeenNthCalledWith(
        1,
        installation.executablePath,
        ['--version'],
        expect.objectContaining({ shell: false }),
        expect.any(Function),
      );
    },
  );

  it('normalizes a missing executable as detection and launch failures', async () => {
    const missing = join(createTemporaryDirectory('claude-missing'), executableName('claude'));
    const adapter = new ClaudeAdapter(missing);

    await expect(adapter.inspect()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'EXECUTABLE_NOT_FOUND',
    });
    const error = await adapter
      .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
      .catch((failure: unknown) => failure);
    expectAdapterFailure(error, 'EXECUTABLE_NOT_FOUND');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid Worktree path with a normalized launch failure', async () => {
    const executablePath = createExecutable(
      createTemporaryDirectory('claude-invalid-worktree'),
      executableName('claude'),
    );
    const error = await new ClaudeAdapter(executablePath)
      .buildLaunchCommand({ environment: {}, workingDirectory: 'relative-worktree' })
      .catch((failure: unknown) => failure);

    expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
  });

  it.runIf(process.platform === 'win32')(
    'rejects a configured file with an unsupported Windows executable extension',
    async () => {
      const root = createTemporaryDirectory('claude-unsupported-extension');
      const unsupportedPath = join(root, 'claude.bat');
      writeFileSync(unsupportedPath, '@echo unsafe wrapper\r\n');

      const error = await new ClaudeAdapter(unsupportedPath)
        .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
        .catch((failure: unknown) => failure);

      expectAdapterFailure(error, 'INSPECTION_FAILED');
    },
  );
});

describe('GeminiAdapter', () => {
  it('detects version and only reports resume when the installed CLI advertises it', async () => {
    const executablePath = createExecutable(
      createTemporaryDirectory('gemini-inspect'),
      executableName('gemini'),
    );
    enqueue(
      successful('0.55.1\n'),
      successful('  -r, --resume [session_id]  Resume a previous chat session\n'),
    );

    const adapter = new GeminiAdapter(executablePath);

    await expect(adapter.inspect()).resolves.toEqual({
      capabilities: ['SESSION_RESUME'],
      executablePath,
      kind: 'available',
      version: { major: 0, minor: 55, patch: 1, raw: '0.55.1' },
    });
    expect(adapter.identity).toEqual({ displayName: 'Gemini', id: 'gemini' });
    const probeEnvironment = (execFileMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }).env;
    expect(probeEnvironment).not.toHaveProperty('GEMINI_API_KEY');
    expect(probeEnvironment).not.toHaveProperty('GOOGLE_API_KEY');
    expect(probeEnvironment).not.toHaveProperty('NODE_OPTIONS');
  });

  it('does not claim resume when the capability probe fails', async () => {
    const executablePath = createExecutable(
      createTemporaryDirectory('gemini-no-resume'),
      executableName('gemini'),
    );
    enqueue(successful('0.55.1\n'), failed(2));

    await expect(new GeminiAdapter(executablePath).inspect()).resolves.toMatchObject({
      capabilities: [],
      kind: 'available',
    });
  });

  it.runIf(process.platform === 'win32')(
    'launches an official npm installation through Node with no shell or provider-agnostic cwd flag',
    async () => {
      const root = createTemporaryDirectory('gemini-npm');
      const installation = createGeminiNpmInstallation(root);
      const workingDirectory = join(root, 'Gemini Tác vụ');
      mkdirSync(workingDirectory);
      const environment = Object.freeze({ SystemRoot: 'C:\\Windows' });

      await expect(
        new GeminiAdapter(installation.shimPath).buildLaunchCommand({
          environment,
          workingDirectory,
        }),
      ).resolves.toEqual({
        arguments: [installation.entrypointPath],
        environment,
        executablePath: installation.nodeExecutablePath,
        workingDirectory: realpathSync.native(workingDirectory),
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects Node injection variables for the official npm installation',
    async () => {
      const installation = createGeminiNpmInstallation(
        createTemporaryDirectory('gemini-node-injection'),
      );
      const error = await new GeminiAdapter(installation.shimPath)
        .buildLaunchCommand({
          environment: { NODE_OPTIONS: '--require malicious.js' },
          workingDirectory: process.cwd(),
        })
        .catch((failure: unknown) => failure);

      expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects an unverified command shim instead of executing wrapper text',
    async () => {
      const root = createTemporaryDirectory('gemini-unverified-shim');
      const shimPath = join(root, 'gemini.cmd');
      writeFileSync(shimPath, '@echo malicious wrapper\r\n');

      const error = await new GeminiAdapter(shimPath)
        .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
        .catch((failure: unknown) => failure);

      expectAdapterFailure(error, 'INSPECTION_FAILED');
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects CI-prefixed markers that force Gemini out of interactive mode',
    async () => {
      const installation = createGeminiNpmInstallation(createTemporaryDirectory('gemini-ci'));
      const error = await new GeminiAdapter(installation.shimPath)
        .buildLaunchCommand({
          environment: { CI_TOKEN: 'present' },
          workingDirectory: process.cwd(),
        })
        .catch((failure: unknown) => failure);

      expectAdapterFailure(error, 'INVALID_LAUNCH_REQUEST');
    },
  );

  it('normalizes a missing executable as detection and launch failures', async () => {
    const missing = join(createTemporaryDirectory('gemini-missing'), executableName('gemini'));
    const adapter = new GeminiAdapter(missing);

    await expect(adapter.inspect()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'EXECUTABLE_NOT_FOUND',
    });
    const error = await adapter
      .buildLaunchCommand({ environment: {}, workingDirectory: process.cwd() })
      .catch((failure: unknown) => failure);
    expectAdapterFailure(error, 'EXECUTABLE_NOT_FOUND');
  });
});
