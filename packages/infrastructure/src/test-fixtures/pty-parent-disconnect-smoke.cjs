'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
/* global clearTimeout, process, require, setTimeout */

const { spawn } = require('node:child_process');

const hostModulePath = requiredEnvironment('AGENTTERM_PTY_HOST_MODULE');
const executablePath = requiredEnvironment('AGENTTERM_PTY_TARGET_EXECUTABLE');
const workingDirectory = requiredEnvironment('AGENTTERM_PTY_WORKING_DIRECTORY');
const host = spawn(process.execPath, [hostModulePath], {
  cwd: workingDirectory,
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    TEMP: process.env.TEMP ?? workingDirectory,
    TMP: process.env.TMP ?? workingDirectory,
  },
  serialization: 'json',
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  windowsHide: true,
});
const watchdog = setTimeout(() => process.exit(2), 8000);

host.on('message', (message) => {
  if (message?.type !== 'ready') return;
  clearTimeout(watchdog);
  process.stdout.write(
    `${JSON.stringify({ hostProcessId: host.pid, targetProcessId: message.pid })}\n`,
    () => process.exit(0),
  );
});
host.once('error', () => process.exit(3));
host.send({
  launch: {
    arguments: ['-e', 'setTimeout(() => process.exit(97), 15000);'],
    environment: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
    executablePath,
    initialColumns: 80,
    initialRows: 24,
    workingDirectory,
  },
  type: 'launch',
});

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
