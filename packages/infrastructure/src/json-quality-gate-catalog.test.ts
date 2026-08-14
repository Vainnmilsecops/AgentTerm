import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { QualityGateKind } from '@agentterm/domain';

import { JsonFileQualityGateCatalog } from './json-quality-gate-catalog';

describe('JsonFileQualityGateCatalog', () => {
  it('starts empty when no file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-catalog-'));
    try {
      const catalog = new JsonFileQualityGateCatalog({ filePath: join(dir, 'gates.json') });
      expect(await catalog.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid gate ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-catalog-'));
    try {
      const catalog = new JsonFileQualityGateCatalog({ filePath: join(dir, 'gates.json') });
      await expect(
        catalog.register({
          command: { arguments: [], executablePath: 'C:/x/node.exe' },
          id: 'INVALID ID',
          kind: QualityGateKind.LINT,
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(/invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists gates across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-catalog-'));
    try {
      const file = join(dir, 'gates.json');
      const writer = new JsonFileQualityGateCatalog({ filePath: file });
      await writer.register({
        command: { arguments: ['run'], executablePath: 'C:/x/node.exe' },
        id: 'lint:eslint',
        kind: QualityGateKind.LINT,
        timeoutMs: 60_000,
      });
      const reader = new JsonFileQualityGateCatalog({ filePath: file });
      const gates = await reader.list();
      expect(gates).toHaveLength(1);
      expect(gates[0]?.id).toBe('lint:eslint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-catalog-'));
    try {
      const catalog = new JsonFileQualityGateCatalog({ filePath: join(dir, 'gates.json') });
      await catalog.register({
        command: { arguments: [], executablePath: 'C:/x/node.exe' },
        id: 'lint:eslint',
        kind: QualityGateKind.LINT,
        timeoutMs: 1_000,
      });
      await expect(
        catalog.register({
          command: { arguments: [], executablePath: 'C:/x/node.exe' },
          id: 'lint:eslint',
          kind: QualityGateKind.LINT,
          timeoutMs: 1_000,
        }),
      ).rejects.toThrow(/already/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed entries when loading', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qg-catalog-'));
    try {
      const file = join(dir, 'gates.json');
      writeFileSync(file, JSON.stringify({ gates: [{ id: '!!' }, { id: 'lint:eslint', kind: 'LINT', executablePath: 'C:/x/node.exe', arguments: [], timeoutMs: 1000 }] }));
      const catalog = new JsonFileQualityGateCatalog({ filePath: file });
      const gates = await catalog.list();
      expect(gates).toHaveLength(1);
      expect(gates[0]?.id).toBe('lint:eslint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});