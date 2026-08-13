import { describe, expect, it } from 'vitest';

import {
  ApplicationSettingsDefaults,
  createApplicationSettings,
  InvalidApplicationSettingsError,
} from './index';

describe('Application Settings', () => {
  it('creates backward-compatible defaults without credentials or speculative preferences', () => {
    const settings = createApplicationSettings();

    expect(settings).toEqual({
      agentExecutables: [],
      defaultAgentId: 'codex',
      revision: 0,
      schemaVersion: 1,
      terminalFontSize: 14,
    });
    expect(ApplicationSettingsDefaults).toEqual({
      defaultAgentId: 'codex',
      terminalFontSize: 14,
    });
    expect(JSON.stringify(settings)).not.toMatch(/token|credential|shell|git/i);
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.agentExecutables)).toBe(true);
  });

  it('normalizes, sorts, copies, and freezes configured executable overrides', () => {
    const source = [
      { agentId: 'gemini', executablePath: ' C:\\Tools\\gemini.cmd ' },
      { agentId: 'claude', executablePath: 'C:\\Tools\\claude.exe' },
    ];
    const settings = createApplicationSettings({
      agentExecutables: source,
      defaultAgentId: 'gemini',
      revision: 4,
      terminalFontSize: 16,
    });
    source[0]!.executablePath = 'C:\\changed.exe';

    expect(settings).toEqual({
      agentExecutables: [
        { agentId: 'claude', executablePath: 'C:\\Tools\\claude.exe' },
        { agentId: 'gemini', executablePath: 'C:\\Tools\\gemini.cmd' },
      ],
      defaultAgentId: 'gemini',
      revision: 4,
      schemaVersion: 1,
      terminalFontSize: 16,
    });
    expect(Object.isFrozen(settings.agentExecutables[0])).toBe(true);
  });

  it.each([
    [{ defaultAgentId: 'Claude CLI' }, 'INVALID_AGENT_ID'],
    [{ revision: -1 }, 'INVALID_REVISION'],
    [{ terminalFontSize: 7 }, 'INVALID_TERMINAL_FONT_SIZE'],
    [{ terminalFontSize: 33 }, 'INVALID_TERMINAL_FONT_SIZE'],
    [{ agentExecutables: [{ agentId: 'codex', executablePath: '   ' }] }, 'INVALID_EXECUTABLE'],
    [
      {
        agentExecutables: [
          { agentId: 'codex', executablePath: 'codex' },
          { agentId: 'codex', executablePath: 'other-codex' },
        ],
      },
      'DUPLICATE_AGENT',
    ],
  ] as const)('rejects invalid settings %#', (input, reason) => {
    expect(() => createApplicationSettings(input)).toThrow(
      expect.objectContaining({ name: 'InvalidApplicationSettingsError', reason }),
    );
  });

  it('uses a typed validation error without echoing an invalid executable path', () => {
    const secretBearingPath = 'C:\\secret-token\\agent\0.exe';

    try {
      createApplicationSettings({
        agentExecutables: [{ agentId: 'codex', executablePath: secretBearingPath }],
      });
      throw new Error('Expected settings validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidApplicationSettingsError);
      expect(String(error)).not.toContain(secretBearingPath);
    }
  });
});
