import { describe, expect, it, vi } from 'vitest';

import { QualityGateKind, createQualityGate } from '@agentterm/domain';

import { registerQualityGate, unregisterQualityGate, type QualityGateConfigInput } from './quality-gate-configuration';

function input(overrides: Partial<QualityGateConfigInput> = {}): QualityGateConfigInput {
  return {
    command: {
      arguments: ['run', '--no-color'],
      executablePath: 'C:/Program Files/nodejs/node.exe',
    },
    id: 'lint:eslint',
    kind: QualityGateKind.LINT,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe('registerQualityGate', () => {
  it('rejects empty ids', async () => {
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    };
    await expect(registerQualityGate(input({ id: '' }), catalog)).rejects.toThrow(/id/);
  });

  it('rejects ids that contain unsupported characters', async () => {
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    };
    await expect(registerQualityGate(input({ id: 'BAD ID!' }), catalog)).rejects.toThrow();
  });

  it('rejects non-positive timeouts', async () => {
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    };
    await expect(registerQualityGate(input({ timeoutMs: 0 }), catalog)).rejects.toThrow(/timeout/);
  });

  it('rejects arguments that contain sensitive flag names', async () => {
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    };
    await expect(
      registerQualityGate(
        input({ command: { arguments: ['--api-key=secret'], executablePath: 'C:/x/node.exe' } }),
        catalog,
      ),
    ).rejects.toThrow(/sensitive/i);
  });

  it('rejects relative executable paths', async () => {
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    };
    await expect(
      registerQualityGate(
        input({ command: { arguments: [], executablePath: 'node.exe' } }),
        catalog,
      ),
    ).rejects.toThrow(/absolute/i);
  });

  it('persists the gate when the input is well-formed', async () => {
    const register = vi.fn();
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register,
      unregister: vi.fn(),
    };
    const persisted = await registerQualityGate(input(), catalog);
    expect(register).toHaveBeenCalledTimes(1);
    expect(persisted.id).toBe('lint:eslint');
    expect(persisted.kind).toBe(QualityGateKind.LINT);
    expect(persisted).toEqual(createQualityGate(input()));
  });
});

describe('unregisterQualityGate', () => {
  it('rejects empty ids', async () => {
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    };
    await expect(unregisterQualityGate('', catalog)).rejects.toThrow(/id/);
  });

  it('calls the catalog unregister and returns true on success', async () => {
    const unregister = vi.fn().mockResolvedValue(true);
    const catalog = {
      findById: vi.fn(),
      list: vi.fn(),
      register: vi.fn(),
      unregister,
    };
    const result = await unregisterQualityGate('lint:eslint', catalog);
    expect(result).toBe(true);
    expect(unregister).toHaveBeenCalledWith('lint:eslint');
  });
});