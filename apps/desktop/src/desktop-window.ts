import type { BrowserWindowConstructorOptions } from 'electron';

export function createDesktopWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  if (
    typeof preloadPath !== 'string' ||
    preloadPath.trim().length === 0 ||
    preloadPath.includes('\0')
  ) {
    throw new TypeError('Desktop preload path is invalid.');
  }
  return {
    backgroundColor: '#0b0d10',
    height: 720,
    minHeight: 480,
    minWidth: 520,
    show: false,
    title: 'AgentTerm',
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
    width: 1120,
  };
}
