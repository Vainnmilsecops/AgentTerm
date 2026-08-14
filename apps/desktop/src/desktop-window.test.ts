import { describe, expect, it } from 'vitest';

import { createDesktopWindowOptions } from './desktop-window';

describe('desktop renderer isolation', () => {
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
