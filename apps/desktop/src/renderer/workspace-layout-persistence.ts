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
  sidebarWidth: 280,
  terminalHeight: 360,
  theme: 'dark',
});

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const TERMINAL_MIN = 180;
const TERMINAL_MAX = 720;
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
  const sidebarWidth = clampNumber(candidate.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, 280);
  const terminalHeight = clampNumber(candidate.terminalHeight, TERMINAL_MIN, TERMINAL_MAX, 360);
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
