export type WorkspaceTerminalTheme = 'dark' | 'light';

export interface ResolvedTerminalTheme {
  readonly background: string;
  readonly cursor: string;
  readonly cursorAccent: string;
  readonly foreground: string;
  readonly selectionBackground: string;
}

type TerminalThemeTokenReader = (name: string) => string;

const fallbackThemes: Readonly<Record<WorkspaceTerminalTheme, ResolvedTerminalTheme>> =
  Object.freeze({
    dark: Object.freeze({
      background: '#0d1117',
      cursor: '#a2c9ff',
      cursorAccent: '#0d1117',
      foreground: '#e0e2ea',
      selectionBackground: 'rgb(162 201 255 / 14%)',
    }),
    light: Object.freeze({
      background: '#f6f8fa',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      foreground: '#1f2328',
      selectionBackground: 'rgb(9 105 218 / 10%)',
    }),
  });

export function resolveTerminalTheme(
  theme: WorkspaceTerminalTheme,
  readToken: TerminalThemeTokenReader,
): ResolvedTerminalTheme {
  const fallback = fallbackThemes[theme];
  return Object.freeze({
    background: tokenOrFallback(readToken, '--surface-floor', fallback.background),
    cursor: tokenOrFallback(readToken, '--accent-primary', fallback.cursor),
    cursorAccent: tokenOrFallback(readToken, '--accent-contrast', fallback.cursorAccent),
    foreground: tokenOrFallback(readToken, '--text-primary', fallback.foreground),
    selectionBackground: tokenOrFallback(readToken, '--accent-soft', fallback.selectionBackground),
  });
}

function tokenOrFallback(
  readToken: TerminalThemeTokenReader,
  name: string,
  fallback: string,
): string {
  const value = readToken(name).trim();
  return value.length === 0 ? fallback : value;
}
