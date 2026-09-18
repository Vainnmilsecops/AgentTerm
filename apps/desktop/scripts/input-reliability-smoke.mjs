import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'vite';

const directory = dirname(fileURLToPath(import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentterm-input-smoke-'));
try {
  const desktopHtml = await readFile(resolve(directory, '../index.html'), 'utf8');
  const csp = desktopHtml.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u,
  )?.[1];
  if (!csp) throw new Error('Desktop CSP missing');
  await build({
    plugins: [
      {
        name: 'desktop-smoke-csp',
        transformIndexHtml: () => [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
            injectTo: 'head-prepend',
          },
        ],
      },
    ],
    configFile: false,
    base: './',
    root: resolve(
      directory,
      process.argv.includes('--task-context')
        ? '../tests/electron/task-context'
        : process.argv.includes('--session-recovery')
          ? '../tests/electron/session-recovery'
          : '../tests/electron/input-reliability',
    ),
    build: { outDir: output, emptyOutDir: false },
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electron,
    [
      join(directory, 'input-reliability-runner.cjs'),
      join(output, 'index.html'),
      ...(process.argv.includes('--task-context')
        ? [resolve(directory, '../dist/main/preload.cjs')]
        : []),
    ],
    { env, windowsHide: true, stdio: 'inherit' },
  );
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    process.exitCode = await new Promise((done, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => done(code ?? 1));
    });
  } finally {
    clearTimeout(timer);
  }
} finally {
  const target = await realpath(output);
  if (dirname(target).toLowerCase() !== (await realpath(tmpdir())).toLowerCase()) {
    process.exitCode = 1;
  } else {
    await rm(target, { recursive: true });
  }
}
