/* global __dirname, console, process, require, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const { tmpdir } = require('node:os');
const { basename, join, relative, resolve } = require('node:path');

const { app, BrowserWindow } = require('electron/main');

const dataDirectory = resolve(process.env.AGENTTERM_WINDOW_VISIBILITY_DATA_DIRECTORY ?? '');
const relativeToTemp = relative(resolve(tmpdir()), dataDirectory);
if (
  relativeToTemp.startsWith('..') ||
  relativeToTemp.length === 0 ||
  !basename(dataDirectory).startsWith('agentterm-window-visibility-')
) {
  throw new Error('The visibility fixture data directory is invalid.');
}
app.setPath('userData', dataDirectory);

app.whenReady().then(() => {
  const desktopDirectory = join(__dirname, '..');
  const window = new BrowserWindow({
    backgroundColor: '#0b0d10',
    height: 480,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(desktopDirectory, 'dist', 'main', 'preload.cjs'),
      sandbox: true,
    },
    width: 520,
    x: -20_000,
    y: -20_000,
  });
  const deadline = Date.now() + 5_000;
  const reportVisibility = () => {
    if (!window.isVisible() && Date.now() < deadline) {
      setTimeout(reportVisibility, 25);
      return;
    }
    console.log(`AGENTTERM_WINDOW_VISIBILITY:${String(window.isVisible())}`);
    app.quit();
  };
  window.once('ready-to-show', () => {
    window.show();
    reportVisibility();
  });
  void window.loadFile(join(desktopDirectory, 'dist', 'renderer', 'index.html'));
});
