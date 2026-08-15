import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const desktopDirectory = fileURLToPath(new URL('../', import.meta.url));
const tsupCli = join(dirname(require.resolve('tsup/package.json')), 'dist', 'cli-default.js');

describe('desktop preload bundle', () => {
  it('bundles every runtime dependency except the sandbox-provided Electron API', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'agentterm-preload-bundle-'));

    try {
      await execFile(
        process.execPath,
        [tsupCli, '--config', 'tsup.preload.config.ts', '--out-dir', outputDirectory, '--silent'],
        {
          cwd: desktopDirectory,
          maxBuffer: 1_048_576,
        },
      );

      const bundle = await readFile(join(outputDirectory, 'preload.cjs'), 'utf8');
      const requiredModules = [...bundle.matchAll(/require\(["']([^"']+)["']\)/gu)].map(
        ([, moduleName]) => moduleName,
      );

      expect(new Set(requiredModules)).toEqual(new Set(['electron']));
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });
});
