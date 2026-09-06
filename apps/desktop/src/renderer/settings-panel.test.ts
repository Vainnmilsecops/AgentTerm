import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ApplicationSettingsView } from '@agentterm/application';

import { SettingsPanel } from './settings-panel';

function buildView(
  overrides: Partial<{ allowClipboardReadWrite: boolean; researchAutoAdvance: boolean }> = {},
): ApplicationSettingsView {
  return {
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
      allowClipboardReadWrite: overrides.allowClipboardReadWrite ?? false,
      defaultAgentId: 'codex',
      mcpServerToken: undefined,
      researchAutoAdvance: overrides.researchAutoAdvance ?? false,
      revision: 0,
      schemaVersion: 3,
      terminalFontSize: 14,
    },
  };
}

function renderPanel(view: ApplicationSettingsView): string {
  return renderToStaticMarkup(
    createElement(SettingsPanel, {
      error: undefined,
      onSave: () => undefined,
      saving: false,
      view,
    }),
  );
}

describe('SettingsPanel', () => {
  it('renders only consumer-backed settings and clear agent availability', () => {
    const markup = renderPanel(buildView());

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

  it('renders an unchecked research auto-advance toggle by default', () => {
    const markup = renderPanel(buildView({ researchAutoAdvance: false }));

    expect(markup).toContain('Auto-advance BACKLOG tasks to PLANNING after a valid research/research.md artifact');
    expect(markup).toMatch(
      /<input[^>]*aria-label="Research auto-advance"[^>]*type="checkbox"[^>]*\/>/u,
    );
    expect(markup).not.toMatch(
      /<input[^>]*aria-label="Research auto-advance"[^>]*checked/u,
    );
  });

  it('renders a checked research auto-advance toggle when enabled', () => {
    const markup = renderPanel(buildView({ researchAutoAdvance: true }));

    expect(markup).toMatch(
      /<input[^>]*aria-label="Research auto-advance"[^>]*type="checkbox"[^>]*checked/u,
    );
  });
});
