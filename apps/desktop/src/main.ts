import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import {
  createProductionDesktopApplication,
  type ProductionDesktopApplication,
} from './desktop-application';
import {
  registerDesktopIpcHandlers,
  type DesktopIpcMain,
  type DesktopIpcMainEvent,
} from './desktop-main-handlers';
import { createBoardWindowOptions, createDesktopWindowOptions } from './desktop-window';

const isSmokeTest = process.argv.includes('--smoke-test');
let mainWindow: BrowserWindow | null = null;
let applicationAttempt: Promise<ProductionDesktopApplication> | undefined;
let applicationInstance: ProductionDesktopApplication | undefined;
let disposeIpcHandlers: (() => void) | undefined;
let smokeDataDirectory: string | undefined;
const boardWindows = new Set<BrowserWindow>();

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

export function createBoardWindow(): BrowserWindow {
  const preloadPath = join(app.getAppPath(), 'dist', 'main', 'preload.cjs');
  const boardWindow = new BrowserWindow(createBoardWindowOptions(preloadPath));
  boardWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  boardWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  boardWindow.once('ready-to-show', () => {
    boardWindow.show();
  });
  boardWindow.on('closed', () => {
    boardWindows.delete(boardWindow);
  });
  boardWindows.add(boardWindow);
  void boardWindow.loadFile(
    join(app.getAppPath(), 'dist', 'renderer', 'board.html'),
  );
  return boardWindow;
}

async function verifySmokeRenderer(window: BrowserWindow | null): Promise<number> {
  try {
    const result = (await window?.webContents.executeJavaScript(
      `(async () => {
        const bridge = window.agenttermWorkspace;
        let workspaceLoaded = false;
        try {
          const workspace = await bridge?.loadWorkspace();
          workspaceLoaded = Array.isArray(workspace?.projects) && Array.isArray(workspace?.agents);
        } catch {}
        return {
          bridgeKeys: Object.keys(bridge ?? {}),
          hasProcess: typeof globalThis.process !== 'undefined',
          hasRawIpc: 'ipcRenderer' in (bridge ?? {}),
          hasRequire: typeof globalThis.require !== 'undefined',
          renderedText: document.getElementById('root')?.textContent ?? '',
          workspaceLoaded
        };
      })()`,
      true,
    )) as
      | {
          readonly bridgeKeys: readonly string[];
          readonly hasProcess: boolean;
          readonly hasRawIpc: boolean;
          readonly hasRequire: boolean;
          readonly renderedText: string;
          readonly workspaceLoaded: boolean;
        }
      | undefined;
    if (
      result === undefined ||
      typeof result.renderedText !== 'string' ||
      result.renderedText.trim().length === 0 ||
      result.hasProcess ||
      result.hasRawIpc ||
      result.hasRequire ||
      !result.workspaceLoaded ||
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
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      event.sender.id === mainWindow.webContents.id &&
      event.senderFrame !== null &&
      event.senderFrame === mainWindow.webContents.mainFrame,
    ipcMain: ipcMain as unknown as DesktopIpcMain,
    openBoardWindow: () => {
      createBoardWindow();
    },
    selectProjectDirectory: async () => {
      const window = mainWindow;
      if (window === null || window.isDestroyed()) return undefined;
      const selection = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Open Git Project',
      });
      const path = selection.filePaths[0];
      return selection.canceled || path === undefined || path.length === 0 ? undefined : path;
    },
    selectQualityGateConfigFile: async () => {
      const window = mainWindow;
      if (window === null || window.isDestroyed()) return undefined;
      const selection = await dialog.showOpenDialog(window, {
        filters: [{ extensions: ['json'], name: 'Quality Gate Configuration' }],
        properties: ['openFile'],
        title: 'Import Quality Gate Configuration',
      });
      const path = selection.filePaths[0];
      return selection.canceled || path === undefined || path.length === 0 ? undefined : path;
    },
  });
}

async function shutdownDesktop(): Promise<void> {
  for (const board of [...boardWindows]) {
    if (!board.isDestroyed()) board.close();
  }
  boardWindows.clear();
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
