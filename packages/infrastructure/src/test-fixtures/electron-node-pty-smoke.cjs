'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
/* global clearTimeout, process, require, setImmediate, setTimeout */

const workerFailureMode = process.env.AGENTTERM_PTY_SMOKE_FAIL_WORKER;
let connectedOutputWorker;
if (workerFailureMode === 'before-ready') {
  const { EventEmitter } = require('node:events');
  const workerThreads = require('node:worker_threads');

  workerThreads.Worker = class FailingConoutWorker extends EventEmitter {
    constructor() {
      super();
      setImmediate(() =>
        this.emit('error', new Error('simulated Conout worker bootstrap failure')),
      );
    }

    terminate() {
      return Promise.resolve(0);
    }
  };
} else if (workerFailureMode === 'after-ready') {
  const { EventEmitter } = require('node:events');
  const workerThreads = require('node:worker_threads');
  const OriginalWorker = workerThreads.Worker;

  workerThreads.Worker = class FailingConnectedConoutWorker extends EventEmitter {
    constructor(...arguments_) {
      super();
      this.worker = new OriginalWorker(...arguments_);
      connectedOutputWorker = this.worker;
      this.worker.on('message', (message) => {
        this.emit('message', message);
      });
      this.worker.on('error', (error) => this.emit('error', error));
      this.worker.on('exit', (code) => this.emit('exit', code));
    }

    terminate() {
      return this.worker.terminate();
    }
  };
}

const nodePty = require('node-pty');

const executablePath = requiredEnvironment('AGENTTERM_PTY_SMOKE_EXECUTABLE');
const workingDirectory = requiredEnvironment('AGENTTERM_PTY_SMOKE_CWD');
const marker = requiredEnvironment('AGENTTERM_PTY_SMOKE_MARKER');
const childScript = String.raw`
if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding('utf8');
process.stdout.write('ELECTRON_CHILD_READY:' + process.env.AGENTTERM_PTY_SMOKE_MARKER + '\n');
const watchdog = setTimeout(() => process.exit(94), 5000);
process.stdin.on('data', (data) => {
  if (data.includes('ping')) {
    clearTimeout(watchdog);
    process.stdout.write('ELECTRON_CHILD_ACK\n', () => process.exit(7));
  }
});
`;

const terminal = nodePty.spawn(executablePath, ['-e', childScript], {
  cols: 82,
  cwd: workingDirectory,
  env: {
    AGENTTERM_PTY_SMOKE_MARKER: marker,
    SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  },
  name: 'xterm-256color',
  rows: 26,
  useConpty: true,
  useConptyDll: false,
});

let output = '';
let settled = false;
const watchdog = setTimeout(
  () => fail('Timed out waiting for the Electron-hosted ConPTY child.'),
  8000,
);
const dataSubscription = terminal.onData((data) => {
  output += data;
});
const exitSubscription = terminal.onExit(({ exitCode, signal }) => {
  if (settled) return;
  settled = true;
  clearTimeout(watchdog);
  dataSubscription.dispose();
  exitSubscription.dispose();

  if (workerFailureMode) {
    const childAliveAtExit = workerFailureMode === 'after-ready' && isProcessAlive(terminal.pid);
    if (
      exitCode !== -1 ||
      signal !== -1 ||
      (workerFailureMode === 'after-ready' && terminal.pid <= 0) ||
      childAliveAtExit
    ) {
      process.stderr.write(
        `Electron node-pty worker failure evidence was exit=${exitCode}, signal=${signal}, pid=${terminal.pid}, childAliveAtExit=${childAliveAtExit}.\n`,
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      workerFailureMode === 'after-ready'
        ? 'ELECTRON_NODE_PTY_CONNECTED_WORKER_FAILURE_OK\n'
        : 'ELECTRON_NODE_PTY_WORKER_FAILURE_OK\n',
    );
    return;
  }

  if (
    exitCode !== 7 ||
    !output.includes(`ELECTRON_CHILD_READY:${marker}`) ||
    !output.includes('ELECTRON_CHILD_ACK')
  ) {
    process.stderr.write(
      `Electron node-pty smoke failed: exit=${exitCode}; output=${JSON.stringify(output)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('ELECTRON_NODE_PTY_SMOKE_OK\n');
});

if (!workerFailureMode) {
  terminal.write('ping\r');
} else if (workerFailureMode === 'after-ready') {
  terminateConnectedWorker();
}

function terminateConnectedWorker() {
  if (settled) return;
  if (terminal.pid > 0 && connectedOutputWorker) {
    void connectedOutputWorker.terminate();
    return;
  }
  setImmediate(terminateConnectedWorker);
}

function fail(message) {
  if (settled) return;
  settled = true;
  clearTimeout(watchdog);
  dataSubscription.dispose();
  exitSubscription.dispose();
  try {
    terminal.kill();
  } catch {
    // The smoke process is already failing; preserve the primary diagnostic.
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 250);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
