'use strict';

/* eslint-disable @typescript-eslint/no-require-imports */
/* global clearTimeout, process, require, setTimeout */

const { isAbsolute } = require('node:path');
const nodePty = require('node-pty');

const FAILURE_SIGNAL = -1;
const MAX_TERMINAL_DIMENSION = 32767;
const SHUTDOWN_TIMEOUT_MS = 2000;

let dataSubscription;
let exitSubscription;
let launchReceived = false;
let settled = false;
let terminal;

process.on('message', (message) => handleMessage(message));
process.once('disconnect', () => terminateAfterParentDisconnect());
process.once('uncaughtException', () => failHost());
process.once('unhandledRejection', () => failHost());

function handleMessage(message) {
  if (!message || typeof message !== 'object' || settled) {
    failHost();
    return;
  }

  if (message.type === 'launch') {
    launch(message.launch);
    return;
  }

  if (message.type !== 'request' || !Number.isSafeInteger(message.requestId)) {
    failHost();
    return;
  }

  handleRequest(message);
}

function launch(spec) {
  if (launchReceived || !isValidLaunch(spec)) {
    failHost();
    return;
  }
  launchReceived = true;

  try {
    terminal = nodePty.spawn(spec.executablePath, spec.arguments, {
      cols: spec.initialColumns,
      cwd: spec.workingDirectory,
      env: spec.environment,
      name: 'xterm-256color',
      rows: spec.initialRows,
      useConpty: true,
      useConptyDll: false,
    });
    dataSubscription = terminal.onData((data) => {
      if (typeof data !== 'string' || !send({ data, type: 'data' })) {
        failHost();
      }
    });
    exitSubscription = terminal.onExit(({ exitCode, signal }) => {
      finish({
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
        ...(typeof signal === 'number' ? { signal } : {}),
        type: 'terminal-exit',
      });
    });
    reportPidWhenReady();
  } catch {
    failHost();
  }
}

function reportPidWhenReady() {
  if (settled) return;
  if (Number.isSafeInteger(terminal?.pid) && terminal.pid > 0) {
    if (!send({ pid: terminal.pid, type: 'ready' })) {
      failHost();
    }
    return;
  }
  setTimeout(reportPidWhenReady, 5);
}

function handleRequest(message) {
  if (!terminal) {
    respond(message.requestId, false);
    return;
  }

  try {
    switch (message.operation) {
      case 'write':
        if (typeof message.input !== 'string') throw new Error('Invalid input');
        terminal.write(message.input);
        break;
      case 'resize':
        if (!isValidDimension(message.columns) || !isValidDimension(message.rows)) {
          throw new Error('Invalid size');
        }
        terminal.resize(message.columns, message.rows);
        break;
      case 'terminate':
        terminal.kill();
        break;
      default:
        respond(message.requestId, false);
        return;
    }
    respond(message.requestId, true);
  } catch {
    respond(message.requestId, false);
  }
}

function respond(requestId, ok) {
  if (!send({ ok, requestId, type: 'response' })) {
    failHost();
  }
}

function finish(exitMessage) {
  if (settled) return;
  settled = true;
  disposeSubscriptions();

  const timeout = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS);
  if (
    !send(exitMessage, () => {
      clearTimeout(timeout);
      process.exit(0);
    })
  ) {
    clearTimeout(timeout);
    process.exit(0);
  }
}

function failHost() {
  if (settled) return;
  settled = true;
  disposeSubscriptions();

  const timeout = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  if (
    !send({ exitCode: -1, signal: FAILURE_SIGNAL, type: 'terminal-exit' }, () => {
      clearTimeout(timeout);
      process.exit(1);
    })
  ) {
    clearTimeout(timeout);
    process.exit(1);
  }
}

function terminateAfterParentDisconnect() {
  settled = true;
  disposeSubscriptions();
  // The host itself is the ownership boundary: process teardown cannot block in node-pty and
  // Windows reclaims the native HPCON, pipe handles, worker, and attached console tree together.
  process.exit(terminal ? 1 : 0);
}

function disposeSubscriptions() {
  try {
    dataSubscription?.dispose();
  } catch {
    // The dedicated process is exiting; no native detail crosses the IPC boundary.
  }
  try {
    exitSubscription?.dispose();
  } catch {
    // The dedicated process is exiting; no native detail crosses the IPC boundary.
  }
  dataSubscription = undefined;
  exitSubscription = undefined;
}

function send(message, callback) {
  if (typeof process.send !== 'function' || !process.connected) return false;
  try {
    process.send(message, callback);
    return true;
  } catch {
    return false;
  }
}

function isValidLaunch(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (
    typeof spec.executablePath !== 'string' ||
    !isAbsolute(spec.executablePath) ||
    spec.executablePath.includes('\0') ||
    typeof spec.workingDirectory !== 'string' ||
    !isAbsolute(spec.workingDirectory) ||
    spec.workingDirectory.includes('\0') ||
    !Array.isArray(spec.arguments) ||
    !spec.arguments.every((argument) => typeof argument === 'string' && !argument.includes('\0')) ||
    !isValidDimension(spec.initialColumns) ||
    !isValidDimension(spec.initialRows) ||
    !spec.environment ||
    typeof spec.environment !== 'object' ||
    Array.isArray(spec.environment)
  ) {
    return false;
  }

  return Object.entries(spec.environment).every(
    ([name, value]) =>
      name.length > 0 &&
      !name.includes('=') &&
      !name.includes('\0') &&
      typeof value === 'string' &&
      !value.includes('\0'),
  );
}

function isValidDimension(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_TERMINAL_DIMENSION;
}
