import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { QualityGateKind } from '@agentterm/domain';

import { describe, expect, it } from 'vitest';

import { createQualityGateConfigurator, __test } from './quality-gate-configurator';

describe('createQualityGateConfigurator', () => {
  function setup(): {
    readonly dir: string;
    readonly path: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'qg-config-'));
    return { dir, path: join(dir, 'gates.json') };
  }

  it('returns PATH_NOT_TRUSTED when the requested path lies outside the trust root', async () => {
    const { dir, path } = setup();
    try {
      const configurator = createQualityGateConfigurator({ trustRoots: [resolve(join(dir, 'sub'))] });
      const result = await configurator.load({ path });
      expect(result.failure).toBe('PATH_NOT_TRUSTED');
      expect(result.value).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns PATH_NOT_TRUSTED on save when the requested path lies outside the trust root', async () => {
    const { dir, path } = setup();
    try {
      const configurator = createQualityGateConfigurator({ trustRoots: [] });
      const result = await configurator.save({
        configuration: { gates: [], path, revision: 'rev-1' },
        path,
      });
      expect(result.failure).toBe('PATH_NOT_TRUSTED');
      expect(result.value).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty configuration when the trusted file does not exist', async () => {
    const { dir, path } = setup();
    try {
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const result = await configurator.load({ path });
      expect(result.failure).toBeUndefined();
      expect(result.value?.gates).toEqual([]);
      expect(result.value?.path).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads a valid configuration file', async () => {
    const { dir, path } = setup();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          revision: 'rev-1',
          gates: [
            {
              arguments: ['run', 'lint'],
              executablePath: 'C:/x/node.exe',
              id: 'lint:eslint',
              kind: 'LINT',
              timeoutMs: 60_000,
            },
          ],
        }),
        'utf8',
      );
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const result = await configurator.load({ path });
      expect(result.failure).toBeUndefined();
      expect(result.value?.gates).toHaveLength(1);
      expect(result.value?.gates[0]?.id).toBe('lint:eslint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns INVALID_FORMAT on malformed JSON', async () => {
    const { dir, path } = setup();
    try {
      writeFileSync(path, '{not json', 'utf8');
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const result = await configurator.load({ path });
      expect(result.failure).toBe('INVALID_FORMAT');
      expect(result.value).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns INVALID_GATE on a missing gate id', async () => {
    const { dir, path } = setup();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          revision: 'rev-1',
          gates: [
            {
              arguments: ['x'],
              executablePath: 'C:/x/node.exe',
              kind: 'LINT',
              timeoutMs: 1000,
            },
          ],
        }),
        'utf8',
      );
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const result = await configurator.load({ path });
      expect(result.failure).toBe('INVALID_GATE');
      expect(result.value).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns INVALID_FORMAT on a gate containing unknown top-level keys', async () => {
    const { dir, path } = setup();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          revision: 'rev-1',
          gates: [
            {
              id: 'lint:eslint',
              kind: 'LINT',
              executablePath: 'C:/x/node.exe',
              arguments: [],
              timeoutMs: 1000,
              secret: 'value',
            },
          ],
        }),
        'utf8',
      );
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const result = await configurator.load({ path });
      expect(result.failure).toBe('INVALID_GATE');
      expect(result.value).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a configuration file atomically', async () => {
    const { dir, path } = setup();
    try {
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const gate = {
        command: { arguments: ['run'], executablePath: 'C:/x/node.exe' },
        id: 'lint:eslint',
        kind: QualityGateKind.LINT,
        timeoutMs: 1_000,
      };
      const writeResult = await configurator.save({
        configuration: { gates: [gate], path, revision: 'rev-1' },
        path,
      });
      expect(writeResult.failure).toBeUndefined();
      const readResult = await configurator.load({ path });
      expect(readResult.failure).toBeUndefined();
      expect(readResult.value?.gates[0]?.id).toBe('lint:eslint');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects save with an invalid gate without touching the file system', async () => {
    const { dir, path } = setup();
    try {
      const configurator = createQualityGateConfigurator({ trustRoots: [path] });
      const result = await configurator.save({
        configuration: {
          gates: [
            {
              command: { arguments: [], executablePath: 'relative/path' },
              id: 'bad',
              kind: QualityGateKind.LINT,
              timeoutMs: 1_000,
            },
          ],
          path,
          revision: 'rev-1',
        },
        path,
      });
      expect(result.failure).toBe('INVALID_GATE');
      expect(result.value).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports reviveGate returning undefined for non-objects', () => {
    expect(__test.reviveGate(null)).toBeUndefined();
    expect(__test.reviveGate(undefined)).toBeUndefined();
    expect(__test.reviveGate('string')).toBeUndefined();
  });

  it('exports isValidGate with strict timeout and argument bounds', () => {
    const okGate = {
      command: { arguments: [], executablePath: 'C:/x/node.exe' },
      id: 'lint:eslint',
      kind: QualityGateKind.LINT,
      timeoutMs: 1_000,
    };
    expect(__test.isValidGate(okGate)).toBe(true);
    expect(__test.isValidGate({ ...okGate, timeoutMs: 0 })).toBe(false);
    expect(__test.isValidGate({ ...okGate, timeoutMs: __test.maximumTimeoutMs + 1 })).toBe(false);
    expect(__test.isValidGate({
      ...okGate,
      command: { arguments: Array.from({ length: __test.maximumGateArguments + 1 }), executablePath: 'C:/x/node.exe' },
    })).toBe(false);
    expect(__test.isValidGate({
      ...okGate,
      command: { arguments: ['a'.repeat(__test.maximumGateArgumentBytes + 1)], executablePath: 'C:/x/node.exe' },
    })).toBe(false);
    expect(__test.isValidGate({ ...okGate, command: { arguments: [], executablePath: 'relative' } })).toBe(false);
    expect(__test.isValidGate({ ...okGate, kind: 'INVALID' as QualityGateKind })).toBe(false);
  });
});