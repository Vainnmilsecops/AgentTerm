/* global __dirname, console, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const electronPath = require('electron');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, [join(__dirname, 'visual-layout-audit.cjs')], {
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error !== undefined) {
  console.error(`AgentTerm visual layout audit could not launch Electron: ${result.error.message}`);
  process.exitCode = 2;
} else {
  process.exitCode = result.status ?? 2;
}
