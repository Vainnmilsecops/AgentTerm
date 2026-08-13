import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SettingsPanel } from './settings-panel';

describe('SettingsPanel', () => {
  it('renders only consumer-backed settings and clear agent availability', () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsPanel, {
        error: undefined,
        onSave: () => undefined,
        saving: false,
        view: {
          agents: [
            {
              capabilities: ['SESSION_RESUME'],
              configuredExecutablePath: 'C:\\Tools\\codex.exe',
              detectedExecutablePath: 'C:\\Tools\\codex.exe',
              displayName: 'Codex',
              id: 'codex',
              kind: 'available',
              version: 'codex 1.2.3',
            },
            {
              configuredExecutablePath: undefined,
              displayName: 'Gemini',
              id: 'gemini',
              kind: 'unavailable',
              reason: 'EXECUTABLE_NOT_FOUND',
            },
          ],
          settings: {
            agentExecutables: [],
            defaultAgentId: 'codex',
            revision: 0,
            schemaVersion: 1,
            terminalFontSize: 14,
          },
        },
      }),
    );

    expect(markup).toContain('<summary>Settings</summary>');
    expect(markup).toContain('Default agent');
    expect(markup).toContain('Terminal font size');
    expect(markup).toContain('Codex executable');
    expect(markup).toContain('Gemini executable');
    expect(markup).toContain('Available');
    expect(markup).toContain('Executable not found');
    expect(markup).toContain('SESSION_RESUME');
    expect(markup).toContain('Detected: C:\\Tools\\codex.exe');
    expect(markup).toContain('CLI manages authentication');
    expect(markup).toContain('active sessions keep running');
    expect(markup).not.toMatch(/token|credential|default shell|git preference/i);
  });
});
