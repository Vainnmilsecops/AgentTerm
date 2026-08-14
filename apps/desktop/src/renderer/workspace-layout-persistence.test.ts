import { describe, expect, it } from 'vitest';

import {
  defaultWorkspaceLayout,
  parsePersistedLayout,
  serializeLayout,
  type WorkspaceLayoutState,
} from './workspace-layout-persistence';

describe('parsePersistedLayout', () => {
  it('returns defaults when the payload is null', () => {
    expect(parsePersistedLayout(null)).toEqual(defaultWorkspaceLayout);
  });

  it('returns defaults when the payload is malformed JSON', () => {
    expect(parsePersistedLayout('not-json')).toEqual(defaultWorkspaceLayout);
  });

  it('clamps the sidebar width into the allowed range', () => {
    const result = parsePersistedLayout(
      JSON.stringify({ sidebarWidth: 9999, terminalHeight: 120 }),
    );
    expect(result.sidebarWidth).toBeLessThanOrEqual(420);
    expect(result.terminalHeight).toBeGreaterThanOrEqual(180);
  });

  it('falls back to defaults for unknown keys and keeps known keys', () => {
    const result = parsePersistedLayout(
      JSON.stringify({ sidebarWidth: 320, theme: 'invalid', sidebarCollapsed: true }),
    );
    expect(result.sidebarWidth).toBe(320);
    expect(result.theme).toBe('dark');
    expect(result.sidebarCollapsed).toBe(true);
  });
});

describe('serializeLayout', () => {
  it('round-trips a layout object back to a stable JSON string', () => {
    const state: WorkspaceLayoutState = {
      ...defaultWorkspaceLayout,
      sidebarCollapsed: true,
      sidebarWidth: 300,
      terminalHeight: 300,
    };
    const json = serializeLayout(state);
    expect(parsePersistedLayout(json)).toEqual(state);
  });
});