import { describe, expect, it } from 'vitest';

import { createDesktopWindowOptions } from './desktop-window';

describe('desktop renderer isolation', () => {
  it('treats the supported 520 by 480 minimum as renderer content size', () => {
    const options = createDesktopWindowOptions('D:\\AgentTerm\\preload.cjs');

    expect(options).toMatchObject({
      height: 720,
      minHeight: 480,
      minWidth: 520,
      useContentSize: true,
      width: 1120,
    });
  });

  it('binds only the sandboxed preload while keeping Node disabled in the renderer', () => {
    const options = createDesktopWindowOptions('D:\\AgentTerm\\preload.cjs');

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      preload: 'D:\\AgentTerm\\preload.cjs',
      sandbox: true,
    });
    expect(options.webPreferences).not.toHaveProperty('enableRemoteModule');
  });
});
