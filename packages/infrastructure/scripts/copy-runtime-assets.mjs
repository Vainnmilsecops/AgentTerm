import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
copyFileSync(
  resolve(packageRoot, 'src/pty/windows-conpty-host.cjs'),
  resolve(packageRoot, 'dist/windows-conpty-host.cjs'),
);
copyFileSync(
  resolve(packageRoot, 'src/quality-gate/windows-job-process-host.ps1'),
  resolve(packageRoot, 'dist/windows-job-process-host.ps1'),
);
