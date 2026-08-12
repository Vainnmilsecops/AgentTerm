import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

const isSmokeTest = process.argv.includes('--smoke-test');
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    backgroundColor: '#0b0d10',
    height: 720,
    minHeight: 480,
    minWidth: 520,
    show: false,
    title: 'AgentTerm',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    width: 1120,
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) {
      mainWindow?.show();
    }
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (isSmokeTest) {
      void verifySmokeRenderer(mainWindow).then((exitCode) => app.exit(exitCode));
    }
  });

  void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
}

async function verifySmokeRenderer(window: BrowserWindow | null): Promise<number> {
  try {
    const renderedText = await window?.webContents.executeJavaScript(
      'document.getElementById("root")?.textContent ?? ""',
    );
    if (typeof renderedText !== 'string' || renderedText.trim().length === 0) {
      console.error('AgentTerm desktop smoke test failed: renderer content is empty.');
      return 1;
    }
    console.log('AgentTerm desktop smoke test passed: renderer content loaded.');
    return 0;
  } catch {
    console.error('AgentTerm desktop smoke test failed: renderer content could not be inspected.');
    return 1;
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
