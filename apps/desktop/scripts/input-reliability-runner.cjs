/* global require, process, console, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, ipcMain } = require('electron');
app.whenReady().then(async () => {
  if (process.argv[3]) {
    ipcMain.handle('agentterm:context:import', (_event, input) => {
      const file = input.files[0];
      if (
        !(file.bytes instanceof Uint8Array) ||
        Buffer.from(file.bytes).toString('utf8') !== 'Xin chào 👋'
      )
        throw new Error('Context bytes did not survive isolated preload/IPC');
      return {
        ok: true,
        value: [
          {
            id: 'ipc-record',
            taskId: input.taskId,
            sessionId: input.sessionId,
            name: file.name,
            mime: file.mime,
            size: file.bytes.length,
            digest: 'a'.repeat(64),
            createdAt: 1,
          },
        ],
      };
    });
  }
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(process.argv[3] ? { preload: process.argv[3] } : {}),
    },
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
