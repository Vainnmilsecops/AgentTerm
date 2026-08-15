import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface ElectronLaunchEnvironmentModule {
  createElectronLaunchEnvironment(
    source: Readonly<Record<string, string | undefined>>,
  ): Record<string, string | undefined>;
  createElectronSpawnOptions(source: Readonly<Record<string, string | undefined>>): {
    readonly env: Record<string, string | undefined>;
    readonly windowsHide: boolean;
  };
}

const require = createRequire(import.meta.url);
const modulePath = fileURLToPath(
  new URL('../scripts/electron-launch-environment.cjs', import.meta.url),
);
const visibilityFixturePath = fileURLToPath(
  new URL('../scripts/electron-window-visibility-fixture.cjs', import.meta.url),
);

describe('Electron launch environment', () => {
  it('removes Node emulation without mutating or dropping unrelated variables', () => {
    const source = Object.freeze({
      AGENTTERM_TEST_MARKER: 'preserved',
      ELECTRON_RUN_AS_NODE: '1',
      EMPTY_VALUE: undefined,
    });
    const environmentModule = loadEnvironmentModule();

    expect(environmentModule?.createElectronLaunchEnvironment).toBeTypeOf('function');
    expect(environmentModule?.createElectronLaunchEnvironment(source)).toEqual({
      AGENTTERM_TEST_MARKER: 'preserved',
      EMPTY_VALUE: undefined,
    });
    expect(source.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it.skipIf(process.platform !== 'win32')(
    'allows a production BrowserWindow to become visible on Windows',
    async () => {
      const environmentModule = loadEnvironmentModule();
      expect(environmentModule?.createElectronSpawnOptions).toBeTypeOf('function');

      const result = await runVisibilityFixture(
        environmentModule?.createElectronSpawnOptions(process.env),
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.visible, result.stderr).toBe(true);
    },
    15_000,
  );
});

async function runVisibilityFixture(
  options:
    | {
        readonly env: Record<string, string | undefined>;
        readonly windowsHide: boolean;
      }
    | undefined,
): Promise<{
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly visible: boolean;
}> {
  if (options === undefined) {
    return { exitCode: null, stderr: 'Electron spawn options are unavailable.', visible: false };
  }
  const electronPath = require('electron') as string;
  const dataDirectory = await mkdtemp(join(tmpdir(), 'agentterm-window-visibility-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(electronPath, [visibilityFixturePath], {
        ...options,
        env: {
          ...options.env,
          AGENTTERM_WINDOW_VISIBILITY_DATA_DIRECTORY: dataDirectory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (exitCode) => {
        const match = /AGENTTERM_WINDOW_VISIBILITY:(true|false)/u.exec(stdout);
        resolve({ exitCode, stderr, visible: match?.[1] === 'true' });
      });
    });
  } finally {
    await rm(dataDirectory, { force: true, recursive: true });
  }
}

function loadEnvironmentModule(): ElectronLaunchEnvironmentModule | undefined {
  try {
    return require(modulePath) as ElectronLaunchEnvironmentModule;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }
    throw error;
  }
}
