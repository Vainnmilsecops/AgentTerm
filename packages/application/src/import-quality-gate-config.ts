import type { QualityGate } from '@agentterm/domain';

import { InvalidQualityGateConfigurationError } from './errors';
import { registerQualityGate } from './quality-gate-configuration';
import type {
  QualityGateCatalog,
  QualityGateConfiguration,
  QualityGateConfigurator,
  QualityGateConfiguratorFailure,
} from './ports';

export interface ImportQualityGateConfigInput {
  /** Absolute path of the trusted configuration file. */
  readonly path: string;
}

export interface ImportQualityGateConfigDependencies {
  readonly catalog: QualityGateCatalog & { register(gate: QualityGate): Promise<void> };
  readonly configurator: QualityGateConfigurator;
}

export interface ImportQualityGateConfigResult {
  /** Final configuration snapshot returned by the configurator. */
  readonly configuration: QualityGateConfiguration;
  /** Gates the configurator validated but the catalog refused to register. */
  readonly rejected: readonly QualityGate[];
  /** Gates successfully registered during this import. */
  readonly registered: readonly QualityGate[];
}

export type ImportQualityGateConfigFailure =
  | 'CATALOG_REJECTED_GATE'
  | 'NO_GATES_TO_IMPORT'
  | QualityGateConfiguratorFailure;

/**
 * Loads a trusted Quality Gate configuration file and registers every gate it contains
 * into the supplied catalog. The configurator performs path trust and validation; the
 * catalog keeps the existing single-writer register contract so concurrent windows
 * cannot silently overwrite one another.
 *
 * The returned `configuration` always reflects the file the configurator read, never a
 * mutated in-memory view. `rejected` enumerates gates the configurator accepted but the
 * catalog refused (e.g. duplicate identity) so the caller can surface them.
 */
export async function importQualityGateConfig(
  input: ImportQualityGateConfigInput,
  dependencies: ImportQualityGateConfigDependencies,
): Promise<ImportQualityGateConfigResult> {
  const result = await dependencies.configurator.load({ path: input.path });
  if (result.failure !== undefined) {
    throw new ImportQualityGateConfiguratorError(result.failure);
  }
  const configuration = result.value;
  if (configuration === undefined) {
    throw new ImportQualityGateConfiguratorError('INVALID_FORMAT');
  }
  if (configuration.gates.length === 0) {
    throw new ImportQualityGateConfiguratorError('NO_GATES_TO_IMPORT');
  }

  const registered: QualityGate[] = [];
  const rejected: QualityGate[] = [];
  for (const gate of configuration.gates) {
    try {
      await registerQualityGate(
        {
          command: gate.command,
          id: gate.id,
          kind: gate.kind,
          timeoutMs: gate.timeoutMs,
        },
        dependencies.catalog,
      );
      registered.push(gate);
    } catch (error) {
      if (error instanceof InvalidQualityGateConfigurationError) {
        rejected.push(gate);
        continue;
      }
      throw error;
    }
  }

  return Object.freeze({
    configuration,
    rejected: Object.freeze([...rejected]),
    registered: Object.freeze([...registered]),
  });
}

export class ImportQualityGateConfiguratorError extends Error {
  public readonly reason: ImportQualityGateConfigFailure;

  public constructor(reason: ImportQualityGateConfigFailure) {
    super(importQualityGateConfiguratorMessage(reason));
    this.name = 'ImportQualityGateConfiguratorError';
    this.reason = reason;
  }
}

function importQualityGateConfiguratorMessage(
  reason: ImportQualityGateConfigFailure,
): string {
  switch (reason) {
    case 'PATH_NOT_TRUSTED':
      return 'The selected Quality Gate configuration file is outside the configured trust root.';
    case 'PATH_UNREADABLE':
      return 'The selected Quality Gate configuration file could not be read.';
    case 'PATH_UNWRITABLE':
      return 'The selected Quality Gate configuration file could not be written.';
    case 'INVALID_FORMAT':
      return 'The Quality Gate configuration file is malformed.';
    case 'INVALID_GATE':
      return 'The Quality Gate configuration contains an unsafe or invalid gate.';
    case 'NO_GATES_TO_IMPORT':
      return 'The Quality Gate configuration file does not contain any gates to import.';
    case 'CATALOG_REJECTED_GATE':
      return 'The Quality Gate catalog refused one or more gates from the configuration file.';
  }
}