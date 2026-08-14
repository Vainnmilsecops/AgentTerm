import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopBridge } from './desktop-bridge';

const bridge = createDesktopBridge({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener);
  },
  removeListener: (channel, listener) => {
    ipcRenderer.removeListener(channel, listener);
  },
});

contextBridge.exposeInMainWorld('agenttermWorkspace', bridge.api);
globalThis.addEventListener('unload', () => bridge.dispose(), { once: true });
