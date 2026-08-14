import {
  QualityGateKind,
  type QualityGate,
  type QualityGateKind as QualityGateKindValue,
} from '@agentterm/domain';

import { InvalidQualityGateConfigurationError } from './errors';
import type { QualityGateCatalog } from './ports';

export interface QualityGateConfigInput {
  readonly command: QualityGate['command'];
  readonly id: string;
  readonly kind: QualityGateKindValue;
  readonly timeoutMs: number;
}

const stableGateIdPattern = /^[a-z0-9]+(?:[._:=-][a-z0-9]+)*$/u;
const sensitiveFlag =
  /(?:^|[-_])(?:api[-_]?key|auth|credential|password|private[-_]?key|secret|token)(?:$|[=_-])/iu;
const sensitiveValue = /(?:authorization\s*:|bearer\s+|basic\s+)[^\s]/iu;
const minimumTimeoutMs = 1_000;
const maximumTimeoutMs = 30 * 60 * 1_000;
const absoluteExecutablePathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

export async function registerQualityGate(
  input: QualityGateConfigInput,
  catalog: QualityGateCatalog & { register(gate: QualityGate): Promise<void> },
): Promise<QualityGate> {
  assertValidConfig(input);
  const gate: QualityGate = Object.freeze({
    command: Object.freeze({
      arguments: Object.freeze([...input.command.arguments]),
      executablePath: input.command.executablePath,
    }),
    id: input.id,
    kind: input.kind,
    timeoutMs: input.timeoutMs,
  });
  await catalog.register(gate);
  return gate;
}

export async function unregisterQualityGate(
  gateId: string,
  catalog: QualityGateCatalog & { unregister(id: string): Promise<boolean> },
): Promise<boolean> {
  assertValidId(gateId);
  return catalog.unregister(gateId);
}

function assertValidConfig(input: QualityGateConfigInput): void {
  assertValidId(input.id);
  assertKnownKind(input.kind);
  assertSafeTimeout(input.timeoutMs);
  assertSafeCommand(input.command);
}

function assertValidId(id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0 || !stableGateIdPattern.test(id)) {
    throw new InvalidQualityGateConfigurationError('id is invalid', { id });
  }
}

function assertKnownKind(kind: QualityGateKindValue): void {
  if (!Object.values(QualityGateKind).includes(kind)) {
    throw new InvalidQualityGateConfigurationError('kind is not supported', { kind });
  }
}

function assertSafeTimeout(timeoutMs: number): void {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < minimumTimeoutMs ||
    timeoutMs > maximumTimeoutMs
  ) {
    throw new InvalidQualityGateConfigurationError('timeoutMs is out of range', { timeoutMs });
  }
}

function assertSafeCommand(command: QualityGate['command']): void {
  if (typeof command.executablePath !== 'string' || !absoluteExecutablePathPattern.test(command.executablePath)) {
    throw new InvalidQualityGateConfigurationError('executablePath must be absolute', {
      executablePath: command.executablePath,
    });
  }
  if (
    !Array.isArray(command.arguments) ||
    command.arguments.some(
      (argument) =>
        typeof argument !== 'string' ||
        argument.length === 0 ||
        sensitiveFlag.test(argument) ||
        sensitiveValue.test(argument),
    )
  ) {
    throw new InvalidQualityGateConfigurationError('arguments contain sensitive flag or value', {});
  }
}