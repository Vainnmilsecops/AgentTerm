/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await window.loadFile(process.argv[2]);
    const result = await window.webContents.executeJavaScript('window.inputReliabilityResult');
    console.log(result.message);
    app.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    app.exit(1);
  }
});
