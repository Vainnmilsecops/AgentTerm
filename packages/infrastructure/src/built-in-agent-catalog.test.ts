import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listAgentSummaries } from '@agentterm/application';
import { createApplicationSettings } from '@agentterm/domain';

import {
  BuiltInAgentConfigurationInspector,
  createBuiltInAgentCatalog,
  createBuiltInAgentCatalogFromSettings,
} from './index';

describe('createBuiltInAgentCatalog', () => {
  it('registers Codex, Claude, and Gemini by stable identifier without provider routing in Application', async () => {
    const missingRoot = join(process.cwd(), 'missing-agentterm-cli-fixtures');
    const catalog = createBuiltInAgentCatalog({
      claudeExecutable: join(missingRoot, 'claude.exe'),
      codexExecutable: join(missingRoot, 'codex.exe'),
      geminiExecutable: join(missingRoot, 'gemini.exe'),
    });

    expect(catalog.list().map((adapter) => adapter.identity)).toEqual([
      { displayName: 'Codex', id: 'codex' },
      { displayName: 'Claude', id: 'claude' },
      { displayName: 'Gemini', id: 'gemini' },
    ]);
    expect(catalog.findById('claude')?.identity.id).toBe('claude');
    expect(catalog.findById('gemini')?.identity.id).toBe('gemini');
    expect(catalog.findById('unknown')).toBeUndefined();
    await expect(listAgentSummaries(catalog)).resolves.toEqual([
      { displayName: 'Codex', id: 'codex', kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' },
      { displayName: 'Claude', id: 'claude', kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' },
      { displayName: 'Gemini', id: 'gemini', kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' },
    ]);
  });
});

describe('Settings-backed built-in agent configuration', () => {
  it('applies executable overrides by stable id while preserving all built-in registrations', async () => {
    const missingRoot = join(process.cwd(), 'missing-agentterm-settings-cli-fixtures');
    const settings = createApplicationSettings({
      agentExecutables: [
        { agentId: 'claude', executablePath: join(missingRoot, 'custom-claude.exe') },
      ],
      defaultAgentId: 'claude',
    });

    const catalog = createBuiltInAgentCatalogFromSettings(settings);

    expect(catalog.list().map(({ identity }) => identity.id)).toEqual([
      'codex',
      'claude',
      'gemini',
    ]);
    await expect(catalog.findById('claude')?.inspect()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'EXECUTABLE_NOT_FOUND',
    });
  });

  it('detects a configured executable through the owning adapter and rejects unknown ids safely', async () => {
    const inspector = new BuiltInAgentConfigurationInspector();
    const missingExecutable = join(process.cwd(), 'missing-agentterm-cli.exe');

    await expect(
      inspector.inspect({ agentId: 'codex', configuredExecutablePath: missingExecutable }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'EXECUTABLE_NOT_FOUND' });
    await expect(inspector.inspect({ agentId: 'unknown' })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'INSPECTION_FAILED',
    });
  });
});
