import { describe, expect, it } from 'vitest';

import { resolveTerminalTheme } from './terminal-theme';

describe('workspace terminal theme', () => {
  it('uses the Technical Precision dark tokens as safe fallbacks', () => {
    expect(resolveTerminalTheme('dark', () => '')).toEqual({
      background: '#0d1117',
      cursor: '#a2c9ff',
      cursorAccent: '#0d1117',
      foreground: '#e0e2ea',
      selectionBackground: 'rgb(162 201 255 / 14%)',
    });
  });

  it('reads live light-theme CSS tokens instead of retaining a dark terminal canvas', () => {
    const tokens = new Map([
      ['--accent-contrast', '#ffffff'],
      ['--accent-primary', '#0969da'],
      ['--accent-soft', 'rgb(9 105 218 / 10%)'],
      ['--surface-floor', '#f6f8fa'],
      ['--text-primary', '#1f2328'],
    ]);

    expect(resolveTerminalTheme('light', (name) => tokens.get(name) ?? '')).toEqual({
      background: '#f6f8fa',
      cursor: '#0969da',
      cursorAccent: '#ffffff',
      foreground: '#1f2328',
      selectionBackground: 'rgb(9 105 218 / 10%)',
    });
  });
});
