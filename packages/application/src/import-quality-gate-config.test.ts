import { describe, expect, it, vi } from 'vitest';

import {
  QualityGateKind,
  type QualityGate,
  type QualityGateKind as QualityGateKindValue,
} from '@agentterm/domain';

import {
  InvalidQualityGateConfigurationError,
} from './errors';
import {
  ImportQualityGateConfiguratorError,
  importQualityGateConfig,
} from './import-quality-gate-config';
import type {
  QualityGateCatalog,
  QualityGateConfiguration,
  QualityGateConfigurator,
  QualityGateConfiguratorFailure,
  QualityGateConfiguratorResult,
} from './ports';

function createSampleGate(overrides: Partial<QualityGate> = {}): QualityGate {
  return Object.freeze({
    command: Object.freeze({
      arguments: Object.freeze(['--max-warnings=0']),
      executablePath: 'C:\\Program Files\\nodejs\\node.exe',
    }),
    id: 'lint',
    kind: 'LINT' as QualityGateKindValue,
    timeoutMs: 60_000,
    ...overrides,
  });
}

function createSampleConfiguration(gates: readonly QualityGate[]): QualityGateConfiguration {
  return Object.freeze({
    gates: Object.freeze([...gates]),
    path: 'C:\\configs\\quality-gates.json',
    revision: 'rev-1',
  });
}

interface FakeConfigurator extends QualityGateConfigurator {
  readonly calls: { readonly path: string }[];
  readonly responses: readonly QualityGateConfiguratorResult<QualityGateConfiguration>[];
}

function createFakeConfigurator(
  responses: readonly QualityGateConfiguratorResult<QualityGateConfiguration>[],
): FakeConfigurator {
  let index = 0;
  const calls: { readonly path: string }[] = [];
  const configurator: FakeConfigurator = {
    calls,
    responses,
    async load(input) {
      calls.push({ path: input.path });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response ?? Object.freeze({ failure: 'INVALID_FORMAT', value: undefined });
    },
    async save() {
      throw new Error('save() is not expected in import-quality-gate-config tests');
    },
  };
  return configurator;
}

interface FakeCatalog extends QualityGateCatalog {
  readonly registered: readonly QualityGate[];
  readonly rejectedIds: readonly string[];
  readonly calls: readonly { readonly id: string }[];
}

function createFakeCatalog(options: {
  readonly reject?: readonly string[];
} = {}): FakeCatalog {
  const registered: QualityGate[] = [];
  const calls: { readonly id: string }[] = [];
  const reject = options.reject ?? [];
  const catalog: FakeCatalog = {
    calls,
    registered,
    rejectedIds: reject,
    async findById(id) {
      return registered.find((entry) => entry.id === id);
    },
    async list() {
      return [...registered];
    },
    async register(gate) {
      calls.push({ id: gate.id });
      if (reject.includes(gate.id)) {
        throw new InvalidQualityGateConfigurationError('id is already registered', { id: gate.id });
      }
      registered.push(gate);
    },
    async unregister(id) {
      const index = registered.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      registered.splice(index, 1);
      return true;
    },
  };
  return catalog;
}

describe('importQualityGateConfig', () => {
  it('registers every gate from a trusted configuration file', async () => {
    const gateA = createSampleGate({ id: 'lint' });
    const gateB = createSampleGate({ id: 'typecheck', kind: QualityGateKind.TYPECHECK });
    const configurator = createFakeConfigurator([
      Object.freeze({ failure: undefined, value: createSampleConfiguration([gateA, gateB]) }),
    ]);
    const catalog = createFakeCatalog();

    const result = await importQualityGateConfig(
      { path: 'C:\\configs\\quality-gates.json' },
      { catalog, configurator },
    );

    expect(configurator.calls).toEqual([{ path: 'C:\\configs\\quality-gates.json' }]);
    expect(catalog.calls.map((entry) => entry.id)).toEqual(['lint', 'typecheck']);
    expect(result.registered).toEqual([gateA, gateB]);
    expect(result.rejected).toEqual([]);
    expect(result.configuration).toEqual(createSampleConfiguration([gateA, gateB]));
  });

  it('reports catalog rejections separately from registered gates', async () => {
    const gateA = createSampleGate({ id: 'lint' });
    const gateB = createSampleGate({ id: 'typecheck', kind: QualityGateKind.TYPECHECK });
    const configurator = createFakeConfigurator([
      Object.freeze({ failure: undefined, value: createSampleConfiguration([gateA, gateB]) }),
    ]);
    const catalog = createFakeCatalog({ reject: ['typecheck'] });

    const result = await importQualityGateConfig(
      { path: 'C:\\configs\\quality-gates.json' },
      { catalog, configurator },
    );

    expect(result.registered).toEqual([gateA]);
    expect(result.rejected).toEqual([gateB]);
  });

  it('throws structured ImportQualityGateConfiguratorError when configurator fails', async () => {
    const configurator = createFakeConfigurator([
      Object.freeze({
        failure: 'PATH_NOT_TRUSTED' satisfies QualityGateConfiguratorFailure,
        value: undefined,
      }),
    ]);
    const catalog = createFakeCatalog();
    const importSpy = vi.spyOn(catalog, 'register');

    await expect(
      importQualityGateConfig(
        { path: 'C:\\untrusted\\quality-gates.json' },
        { catalog, configurator },
      ),
    ).rejects.toMatchObject({
      name: 'ImportQualityGateConfiguratorError',
      reason: 'PATH_NOT_TRUSTED',
    });

    expect(importSpy).not.toHaveBeenCalled();
  });

  it('throws when the configurator returns an undefined value without a failure', async () => {
    const configurator = createFakeConfigurator([
      Object.freeze({ failure: undefined, value: undefined }),
    ]);
    const catalog = createFakeCatalog();

    await expect(
      importQualityGateConfig({ path: 'C:\\empty.json' }, { catalog, configurator }),
    ).rejects.toBeInstanceOf(ImportQualityGateConfiguratorError);
  });

  it('throws NO_GATES_TO_IMPORT when the file contains no gates', async () => {
    const configurator = createFakeConfigurator([
      Object.freeze({ failure: undefined, value: createSampleConfiguration([]) }),
    ]);
    const catalog = createFakeCatalog();

    await expect(
      importQualityGateConfig({ path: 'C:\\empty.json' }, { catalog, configurator }),
    ).rejects.toMatchObject({
      name: 'ImportQualityGateConfiguratorError',
      reason: 'NO_GATES_TO_IMPORT',
    });
  });

  it('propagates unexpected catalog errors so callers can distinguish them from rejections', async () => {
    const gateA = createSampleGate({ id: 'lint' });
    const configurator = createFakeConfigurator([
      Object.freeze({ failure: undefined, value: createSampleConfiguration([gateA]) }),
    ]);
    const catalog = createFakeCatalog();
    vi.spyOn(catalog, 'register').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      importQualityGateConfig({ path: 'C:\\cfg.json' }, { catalog, configurator }),
    ).rejects.toThrow('disk full');
  });
});