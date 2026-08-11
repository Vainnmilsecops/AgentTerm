import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const infrastructureSourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(infrastructureSourceDirectory, '../../..');

describe('node-pty Electron compatibility', () => {
  it.runIf(process.platform === 'win32')(
    'loads the native dependency and spawns ConPTY in Electron 43 embedded Node',
    async () => {
      const electronExecutable = verifiedFile(
        resolve(repositoryRoot, 'apps/desktop/node_modules/electron/dist/electron.exe'),
      );
      const fixture = verifiedFile(
        resolve(infrastructureSourceDirectory, 'test-fixtures/electron-node-pty-smoke.cjs'),
      );
      const smokeExecutable = verifiedFile(process.execPath);
      const workingDirectory = realpathSync.native(tmpdir());

      const result = await executeFile(electronExecutable, [fixture], {
        AGENTTERM_PTY_SMOKE_CWD: workingDirectory,
        AGENTTERM_PTY_SMOKE_EXECUTABLE: smokeExecutable,
        AGENTTERM_PTY_SMOKE_MARKER: 'electron-43-napi-ok',
        ELECTRON_RUN_AS_NODE: '1',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: process.env.TEMP ?? workingDirectory,
        TMP: process.env.TMP ?? workingDirectory,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('ELECTRON_NODE_PTY_SMOKE_OK');
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'surfaces ConPTY output-worker bootstrap failure and shuts down naturally',
    async () => {
      const electronExecutable = verifiedFile(
        resolve(repositoryRoot, 'apps/desktop/node_modules/electron/dist/electron.exe'),
      );
      const fixture = verifiedFile(
        resolve(infrastructureSourceDirectory, 'test-fixtures/electron-node-pty-smoke.cjs'),
      );
      const workingDirectory = realpathSync.native(tmpdir());

      const result = await executeFile(electronExecutable, [fixture], {
        AGENTTERM_PTY_SMOKE_CWD: workingDirectory,
        AGENTTERM_PTY_SMOKE_EXECUTABLE: verifiedFile(process.execPath),
        AGENTTERM_PTY_SMOKE_FAIL_WORKER: 'before-ready',
        AGENTTERM_PTY_SMOKE_MARKER: 'worker-failure-fixture',
        ELECTRON_RUN_AS_NODE: '1',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: process.env.TEMP ?? workingDirectory,
        TMP: process.env.TMP ?? workingDirectory,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('ELECTRON_NODE_PTY_WORKER_FAILURE_OK');
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'terminates the owned child when the connected ConPTY output worker fails',
    async () => {
      const electronExecutable = verifiedFile(
        resolve(repositoryRoot, 'apps/desktop/node_modules/electron/dist/electron.exe'),
      );
      const fixture = verifiedFile(
        resolve(infrastructureSourceDirectory, 'test-fixtures/electron-node-pty-smoke.cjs'),
      );
      const workingDirectory = realpathSync.native(tmpdir());

      const result = await executeFile(electronExecutable, [fixture], {
        AGENTTERM_PTY_SMOKE_CWD: workingDirectory,
        AGENTTERM_PTY_SMOKE_EXECUTABLE: verifiedFile(process.execPath),
        AGENTTERM_PTY_SMOKE_FAIL_WORKER: 'after-ready',
        AGENTTERM_PTY_SMOKE_MARKER: 'connected-worker-failure-fixture',
        ELECTRON_RUN_AS_NODE: '1',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: process.env.TEMP ?? workingDirectory,
        TMP: process.env.TMP ?? workingDirectory,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('ELECTRON_NODE_PTY_CONNECTED_WORKER_FAILURE_OK');
    },
    15_000,
  );

  it.runIf(process.platform === 'win32')(
    'runs the production host-process topology under Electron 43 embedded Node',
    async () => {
      const electronExecutable = verifiedFile(
        resolve(repositoryRoot, 'apps/desktop/node_modules/electron/dist/electron.exe'),
      );
      const fixture = verifiedFile(
        resolve(infrastructureSourceDirectory, 'test-fixtures/electron-hosted-conpty-smoke.cjs'),
      );
      const hostModule = verifiedFile(
        resolve(infrastructureSourceDirectory, 'pty/windows-conpty-host.cjs'),
      );
      const workingDirectory = realpathSync.native(tmpdir());

      const result = await executeFile(electronExecutable, [fixture], {
        AGENTTERM_PTY_PARENT_SENTINEL: 'must-not-reach-target',
        AGENTTERM_PTY_SMOKE_CWD: workingDirectory,
        AGENTTERM_PTY_SMOKE_EXECUTABLE: verifiedFile(process.execPath),
        AGENTTERM_PTY_SMOKE_HOST_MODULE: hostModule,
        AGENTTERM_PTY_SMOKE_MARKER: 'electron-host-process-ok',
        ELECTRON_RUN_AS_NODE: '1',
        SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        TEMP: process.env.TEMP ?? workingDirectory,
        TMP: process.env.TMP ?? workingDirectory,
      });

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('ELECTRON_HOSTED_CONPTY_SMOKE_OK');
    },
    20_000,
  );
});

function verifiedFile(path: string): string {
  expect(isAbsolute(path)).toBe(true);
  const canonicalPath = realpathSync.native(path);
  expect(statSync(canonicalPath).isFile()).toBe(true);
  return canonicalPath;
}

function executeFile(
  executablePath: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executablePath,
      [...arguments_],
      {
        cwd: dirname(executablePath),
        encoding: 'utf8',
        env: environment,
        timeout: 12_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Electron node-pty compatibility fixture failed: ${error.message}; stdout=${stdout}; stderr=${stderr}`,
              { cause: error },
            ),
          );
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
  });
}
