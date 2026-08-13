import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listAgentSummaries } from '@agentterm/application';

import { createBuiltInAgentCatalog } from './index';

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
