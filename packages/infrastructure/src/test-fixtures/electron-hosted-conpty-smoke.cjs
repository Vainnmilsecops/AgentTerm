'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
/* global clearTimeout, process, require, setTimeout */

const { spawn } = require('node:child_process');

const hostModulePath = requiredEnvironment('AGENTTERM_PTY_SMOKE_HOST_MODULE');
const executablePath = requiredEnvironment('AGENTTERM_PTY_SMOKE_EXECUTABLE');
const workingDirectory = requiredEnvironment('AGENTTERM_PTY_SMOKE_CWD');
const marker = requiredEnvironment('AGENTTERM_PTY_SMOKE_MARKER');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const targetScript = String.raw`
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdout.write('HOSTED_READY:' + process.env.AGENTTERM_PTY_SMOKE_MARKER + ':' + (process.env.AGENTTERM_PTY_PARENT_SENTINEL ?? 'absent') + '\n');
process.stdin.once('data', (data) => {
  process.stdout.write('HOSTED_ACK:' + data.trim() + ':' + process.stdout.columns + 'x' + process.stdout.rows + '\n', () => process.exit(19));
});
setTimeout(() => process.exit(98), 8000);
`;

const host = spawn(process.execPath, [hostModulePath], {
  cwd: workingDirectory,
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    SystemRoot: systemRoot,
    TEMP: process.env.TEMP ?? workingDirectory,
    TMP: process.env.TMP ?? workingDirectory,
  },
  serialization: 'json',
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  windowsHide: true,
});

let exitEvidence;
let output = '';
const responses = new Map();
let settled = false;
const watchdog = setTimeout(() => fail('Timed out waiting for hosted Electron ConPTY.'), 12000);

host.on('message', (message) => {
  if (!message || typeof message !== 'object') return fail('Malformed PTY host message.');
  switch (message.type) {
    case 'ready':
      host.send({ columns: 99, operation: 'resize', requestId: 1, rows: 31, type: 'request' });
      host.send({ input: 'ping\r', operation: 'write', requestId: 2, type: 'request' });
      return;
    case 'data':
      output += message.data;
      return;
    case 'response':
      responses.set(message.requestId, message.ok);
      return;
    case 'terminal-exit':
      exitEvidence = message;
  }
});
host.once('error', () => fail('Electron PTY host process failed.'));
host.once('close', (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(watchdog);
  if (
    code !== 0 ||
    exitEvidence?.exitCode !== 19 ||
    output.indexOf(`HOSTED_READY:${marker}:absent`) === -1 ||
    output.indexOf('HOSTED_ACK:ping:99x31') === -1 ||
    responses.get(1) !== true ||
    responses.get(2) !== true
  ) {
    process.stderr.write(
      `Electron hosted ConPTY smoke failed: code=${code}, exit=${JSON.stringify(exitEvidence)}, output=${JSON.stringify(output)}, responses=${JSON.stringify([...responses])}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('ELECTRON_HOSTED_CONPTY_SMOKE_OK\n');
});

host.send({
  launch: {
    arguments: ['-e', targetScript],
    environment: { AGENTTERM_PTY_SMOKE_MARKER: marker, SystemRoot: systemRoot },
    executablePath,
    initialColumns: 83,
    initialRows: 27,
    workingDirectory,
  },
  type: 'launch',
});

function fail(message) {
  if (settled) return;
  settled = true;
  clearTimeout(watchdog);
  host.kill();
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 250);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
