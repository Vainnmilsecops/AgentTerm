import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import {
  createProductionDesktopApplication,
  type ProductionDesktopApplication,
} from './desktop-application';
import {
  registerDesktopIpcHandlers,
  type DesktopIpcMain,
  type DesktopIpcMainEvent,
} from './desktop-main-handlers';
import { createDesktopWindowOptions } from './desktop-window';

const isSmokeTest = process.argv.includes('--smoke-test');
let mainWindow: BrowserWindow | null = null;
let applicationAttempt: Promise<ProductionDesktopApplication> | undefined;
let applicationInstance: ProductionDesktopApplication | undefined;
let disposeIpcHandlers: (() => void) | undefined;
let smokeDataDirectory: string | undefined;

function createWindow(): void {
  const preloadPath = join(app.getAppPath(), 'dist', 'main', 'preload.cjs');
  mainWindow = new BrowserWindow(createDesktopWindowOptions(preloadPath));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (!isSmokeTest) mainWindow?.show();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    if (isSmokeTest) {
      void verifySmokeRenderer(mainWindow).then(async (exitCode) => {
        await shutdownDesktop();
        app.exit(exitCode);
      });
    }
  });

  void mainWindow.loadFile(join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
}

async function verifySmokeRenderer(window: BrowserWindow | null): Promise<number> {
  try {
    const result = (await window?.webContents.executeJavaScript(
      `({
        bridgeKeys: Object.keys(window.agenttermWorkspace ?? {}),
        hasProcess: typeof globalThis.process !== 'undefined',
        hasRawIpc: 'ipcRenderer' in (window.agenttermWorkspace ?? {}),
        hasRequire: typeof globalThis.require !== 'undefined',
        renderedText: document.getElementById('root')?.textContent ?? ''
      })`,
      true,
    )) as
      | {
          readonly bridgeKeys: readonly string[];
          readonly hasProcess: boolean;
          readonly hasRawIpc: boolean;
          readonly hasRequire: boolean;
          readonly renderedText: string;
        }
      | undefined;
    if (
      result === undefined ||
      typeof result.renderedText !== 'string' ||
      result.renderedText.trim().length === 0 ||
      result.hasProcess ||
      result.hasRawIpc ||
      result.hasRequire ||
      !result.bridgeKeys.includes('loadWorkspace') ||
      result.bridgeKeys.includes('invoke')
    ) {
      console.error('AgentTerm desktop smoke test failed: renderer isolation is invalid.');
      return 1;
    }
    console.log('AgentTerm desktop smoke test passed: isolated preload bridge loaded.');
    return 0;
  } catch {
    console.error('AgentTerm desktop smoke test failed: renderer could not be inspected.');
    return 1;
  }
}

function startDesktopApplication(): void {
  const dataDirectory = isSmokeTest
    ? (smokeDataDirectory ??= mkdtempSync(join(tmpdir(), 'agentterm-electron-smoke-')))
    : app.getPath('userData');
  applicationAttempt = createProductionDesktopApplication({ dataDirectory });
  void applicationAttempt
    .then((application) => {
      applicationInstance = application;
    })
    .catch(() => {
      console.error('AgentTerm desktop application composition failed.');
    });
  disposeIpcHandlers = registerDesktopIpcHandlers({
    application: applicationAttempt,
    authorize: (event: DesktopIpcMainEvent) =>
      event.frameId === 0 &&
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      event.sender.id === mainWindow.webContents.id,
    ipcMain: ipcMain as unknown as DesktopIpcMain,
  });
}

async function shutdownDesktop(): Promise<void> {
  disposeIpcHandlers?.();
  disposeIpcHandlers = undefined;
  if (applicationInstance === undefined && applicationAttempt !== undefined) {
    try {
      applicationInstance = await applicationAttempt;
    } catch {
      // Failed startup owns no usable Application composition to close.
    }
  }
  applicationInstance?.dispose();
  applicationInstance = undefined;
  applicationAttempt = undefined;
  if (smokeDataDirectory !== undefined) {
    const directory = smokeDataDirectory;
    smokeDataDirectory = undefined;
    rmSync(directory, { force: true, recursive: true });
  }
}

app.whenReady().then(() => {
  startDesktopApplication();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  disposeIpcHandlers?.();
  applicationInstance?.dispose();
});
