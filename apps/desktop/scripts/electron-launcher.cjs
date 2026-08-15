/* global __dirname, console, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const electronPath = require('electron');
const { createElectronSpawnOptions } = require('./electron-launch-environment.cjs');

const result = spawnSync(electronPath, [join(__dirname, '..'), ...process.argv.slice(2)], {
  ...createElectronSpawnOptions(process.env),
  stdio: 'inherit',
});

if (result.error !== undefined) {
  console.error(`AgentTerm could not launch Electron: ${result.error.message}`);
  process.exitCode = 2;
} else {
  process.exitCode = result.status ?? 2;
}
