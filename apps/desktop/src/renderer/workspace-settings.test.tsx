import { describe, expect, it, vi } from 'vitest';

import { defaultWorkspaceLayout } from './workspace-layout-persistence';

describe('workspace settings integration', () => {
  it('exposes the default layout with sensible values', () => {
    expect(defaultWorkspaceLayout.sidebarWidth).toBeGreaterThanOrEqual(220);
    expect(defaultWorkspaceLayout.terminalHeight).toBeGreaterThanOrEqual(180);
    expect(defaultWorkspaceLayout.theme).toBe('dark');
    expect(defaultWorkspaceLayout.sidebarCollapsed).toBe(false);
  });

  it('invokes onLayoutChange when toggling theme', async () => {
    const onLayoutChange = vi.fn();
    const { WorkspaceSettings } = await import('./workspace-settings');
    const tree = WorkspaceSettings({ layout: defaultWorkspaceLayout, onLayoutChange });
    expect(tree).toBeDefined();
    const button = findButton(tree, 'toggle-theme');
    button.props.onClick();
    expect(onLayoutChange).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'light' }),
    );
  });
});

function findButton(tree: unknown, action: string): { props: { onClick: () => void } } {
  const queue: unknown[] = [tree];
  while (queue.length > 0) {
    const node = queue.shift() as { props?: { children?: unknown; 'data-settings-action'?: string }; children?: unknown } | string | number | null | undefined;
    if (node === null || node === undefined || typeof node !== 'object') {
      continue;
    }
    const candidate = node as { props?: { children?: unknown; 'data-settings-action'?: string }; children?: unknown };
    if (candidate.props?.['data-settings-action'] === action) {
      return candidate as { props: { onClick: () => void } };
    }
    if (candidate.props?.children !== undefined) {
      queue.push(candidate.props.children);
    }
    if (candidate.children !== undefined) {
      queue.push(candidate.children);
    }
  }
  throw new Error(`Button with data-settings-action="${action}" not found`);
}