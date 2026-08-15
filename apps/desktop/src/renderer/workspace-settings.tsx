import type { ReactNode } from 'react';

import type { WorkspaceLayoutState } from './workspace-layout-persistence';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  TERMINAL_MAX_HEIGHT,
  TERMINAL_MIN_HEIGHT,
} from './workspace-layout-persistence';

export interface WorkspaceSettingsProps {
  readonly layout: WorkspaceLayoutState;
  readonly onLayoutChange: (next: WorkspaceLayoutState) => void;
}

export function WorkspaceSettings({ layout, onLayoutChange }: WorkspaceSettingsProps): ReactNode {
  const sidebarPosition: 'left' | 'right' = layout.sidebarPosition;
  const theme: 'dark' | 'light' = layout.theme;
  return (
    <div className="workspace-settings" data-workspace-settings>
      <div className="workspace-settings__row">
        <span className="workspace-settings__label">Sidebar position</span>
        <div
          className="workspace-settings__segment"
          role="radiogroup"
          aria-label="Sidebar position"
        >
          {(['left', 'right'] as const).map((value) => (
            <button
              aria-checked={sidebarPosition === value}
              className={`workspace-settings__segment-option${sidebarPosition === value ? ' is-active' : ''}`}
              data-settings-action={`sidebar-position-${value}`}
              key={value}
              onClick={() => onLayoutChange({ ...layout, sidebarPosition: value })}
              role="radio"
              type="button"
            >
              {value === 'left' ? 'Left' : 'Right'}
            </button>
          ))}
        </div>
      </div>
      <div className="workspace-settings__row">
        <span className="workspace-settings__label">Theme</span>
        <button
          className="workspace-settings__toggle"
          data-settings-action="toggle-theme"
          onClick={() => onLayoutChange({ ...layout, theme: theme === 'dark' ? 'light' : 'dark' })}
          type="button"
        >
          {theme === 'dark' ? 'Dark' : 'Light'}
        </button>
      </div>
      <div className="workspace-settings__row">
        <span className="workspace-settings__label">Sidebar width</span>
        <input
          aria-label="Sidebar width"
          data-settings-action="sidebar-width"
          max={SIDEBAR_MAX_WIDTH}
          min={SIDEBAR_MIN_WIDTH}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next)) {
              onLayoutChange({ ...layout, sidebarWidth: next });
            }
          }}
          step={10}
          type="range"
          value={layout.sidebarWidth}
        />
      </div>
      <div className="workspace-settings__row">
        <span className="workspace-settings__label">Terminal height</span>
        <input
          aria-label="Terminal height"
          data-settings-action="terminal-height"
          max={TERMINAL_MAX_HEIGHT}
          min={TERMINAL_MIN_HEIGHT}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next)) {
              onLayoutChange({ ...layout, terminalHeight: next });
            }
          }}
          step={20}
          type="range"
          value={layout.terminalHeight}
        />
      </div>
    </div>
  );
}
