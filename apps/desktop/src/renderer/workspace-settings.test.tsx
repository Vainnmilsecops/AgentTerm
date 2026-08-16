import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceSettings } from './workspace-settings';
import { defaultWorkspaceLayout } from './workspace-layout-persistence';

describe('workspace settings integration', () => {
  it('exposes the default layout with sensible values', () => {
    expect(defaultWorkspaceLayout.sidebarWidth).toBeGreaterThanOrEqual(220);
    expect(defaultWorkspaceLayout.terminalHeight).toBeGreaterThanOrEqual(180);
    expect(defaultWorkspaceLayout.theme).toBe('dark');
    expect(defaultWorkspaceLayout.sidebarCollapsed).toBe(false);
  });

  it('exposes a toggle-theme control that the host can react to', async () => {
    const onLayoutChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(WorkspaceSettings, {
        layout: defaultWorkspaceLayout,
        onLayoutChange,
      }),
    );
    expect(html).toContain('data-settings-action="toggle-theme"');
  });
});