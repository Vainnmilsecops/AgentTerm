export type WorkspaceTheme = 'dark' | 'light';

export interface WorkspaceLayoutState {
  readonly sidebarCollapsed: boolean;
  readonly sidebarPosition: 'left' | 'right';
  readonly sidebarWidth: number;
  readonly terminalHeight: number;
  readonly theme: WorkspaceTheme;
}

export const defaultWorkspaceLayout: WorkspaceLayoutState = Object.freeze({
  sidebarCollapsed: false,
  sidebarPosition: 'left',
  sidebarWidth: 256,
  terminalHeight: 264,
  theme: 'dark',
});

export const SIDEBAR_MIN_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 400;
export const TERMINAL_MIN_HEIGHT = 176;
export const TERMINAL_MAX_HEIGHT = 640;
const STORAGE_KEY = 'agentterm-workspace-layout';

export function parsePersistedLayout(raw: string | null): WorkspaceLayoutState {
  if (raw === null) {
    return defaultWorkspaceLayout;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultWorkspaceLayout;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return defaultWorkspaceLayout;
  }
  const candidate = parsed as Record<string, unknown>;
  const sidebarPosition = candidate.sidebarPosition === 'right' ? 'right' : 'left';
  const theme = candidate.theme === 'light' ? 'light' : 'dark';
  const sidebarWidth = clampNumber(
    candidate.sidebarWidth,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    defaultWorkspaceLayout.sidebarWidth,
  );
  const terminalHeight = clampNumber(
    candidate.terminalHeight,
    TERMINAL_MIN_HEIGHT,
    TERMINAL_MAX_HEIGHT,
    defaultWorkspaceLayout.terminalHeight,
  );
  const sidebarCollapsed = candidate.sidebarCollapsed === true;
  return Object.freeze({
    sidebarCollapsed,
    sidebarPosition,
    sidebarWidth,
    terminalHeight,
    theme,
  });
}

export function serializeLayout(state: WorkspaceLayoutState): string {
  return JSON.stringify(state);
}

export function readPersistedLayout(): WorkspaceLayoutState {
  if (typeof window === 'undefined') {
    return defaultWorkspaceLayout;
  }
  try {
    return parsePersistedLayout(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return defaultWorkspaceLayout;
  }
}

export function writePersistedLayout(state: WorkspaceLayoutState): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeLayout(state));
  } catch {
    // ignore quota / privacy errors
  }
}

export function layoutStorageKey(): string {
  return STORAGE_KEY;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded < min) {
    return min;
  }
  if (rounded > max) {
    return max;
  }
  return rounded;
}
