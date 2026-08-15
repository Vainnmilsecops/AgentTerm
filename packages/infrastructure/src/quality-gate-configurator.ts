import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { QualityGateKind, type QualityGate } from '@agentterm/domain';

import type {
  QualityGateConfiguration,
  QualityGateConfigurator,
  QualityGateConfiguratorFailure,
  QualityGateConfiguratorResult,
} from '@agentterm/application';

const stableGateIdPattern = /^[a-z0-9]+(?:[._:=-][a-z0-9]+)*$/u;
const absoluteExecutablePathPattern = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;
const maximumConfigBytes = 64 * 1024;
const maximumGateArguments = 32;
const maximumGateArgumentBytes = 1024;
const maximumTimeoutMs = 7_200_000;
const minimumTimeoutMs = 1;
const maximumRevisionLength = 128;

export interface QualityGateConfiguratorFileSystem {
  /** Reads a UTF-8 text file; returns undefined when the file does not exist. */
  readText(path: string): string | undefined;
  /** Writes a UTF-8 text file atomically (temp-file + rename). */
  writeText(path: string, content: string): void;
  /** Returns the realpath of `path` when it exists, undefined otherwise. */
  resolveRealPath(path: string): string | undefined;
}

export interface CreateQualityGateConfiguratorOptions {
  readonly fileSystem?: QualityGateConfiguratorFileSystem;
  readonly trustRoots: readonly string[];
}

const defaultFileSystem: QualityGateConfiguratorFileSystem = {
  readText(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
  resolveRealPath(path) {
    try {
      return realpathSync(path);
    } catch {
      return undefined;
    }
  },
  writeText(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, content, 'utf8');
    try {
      renameSync(tempPath, path);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // best-effort cleanup
      }
      throw error;
    }
  },
};

export function createQualityGateConfigurator(
  options: CreateQualityGateConfiguratorOptions,
): QualityGateConfigurator {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const trustRoots = options.trustRoots.map((root) => normalizeTrustRoot(root, fileSystem));

  const resolveTrustedPath = (path: string): string | undefined => {
    const absolute = isAbsolute(path) ? path : resolve(path);
    const real = fileSystem.resolveRealPath(absolute) ?? absolute;
    return trustRoots.includes(real) ? real : undefined;
  };

  return {
    async load(input) {
      const trusted = resolveTrustedPath(input.path);
      if (trusted === undefined) {
        return failure('PATH_NOT_TRUSTED');
      }
      const raw = fileSystem.readText(trusted);
      if (raw === undefined) {
        return Object.freeze({
          failure: undefined,
          value: Object.freeze({ gates: Object.freeze([]), path: trusted, revision: 'empty' }),
        });
      }
      if (Buffer.byteLength(raw, 'utf8') > maximumConfigBytes) {
        return failure('INVALID_FORMAT');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return failure('INVALID_FORMAT');
      }
      const record = readRecord(parsed);
      const revision = readRevision(record.revision);
      const gatesRaw = record.gates;
      if (!Array.isArray(gatesRaw)) {
        return failure('INVALID_FORMAT');
      }
      const gates: QualityGate[] = [];
      for (const candidate of gatesRaw) {
        const gate = reviveGate(candidate);
        if (gate === undefined) return failure('INVALID_GATE');
        gates.push(gate);
      }
      return success({ gates: Object.freeze(gates), path: trusted, revision });
    },

    async save(input) {
      if (input.configuration.gates.length > 32) return failure('INVALID_GATE');
      for (const gate of input.configuration.gates) {
        if (!isValidGate(gate)) return failure('INVALID_GATE');
      }
      const revision = readRevision(input.configuration.revision);
      const trusted = resolveTrustedPath(input.path);
      if (trusted === undefined) return failure('PATH_NOT_TRUSTED');
      const payload = JSON.stringify(
        {
          revision,
          gates: input.configuration.gates.map((gate) => ({
            arguments: gate.command.arguments,
            executablePath: gate.command.executablePath,
            id: gate.id,
            kind: gate.kind,
            timeoutMs: gate.timeoutMs,
          })),
        },
        null,
        2,
      );
      try {
        fileSystem.writeText(trusted, `${payload}\n`);
      } catch {
        return failure('PATH_UNWRITABLE');
      }
      return success({
        gates: Object.freeze([...input.configuration.gates]),
        path: trusted,
        revision,
      });
    },
  };
}

function normalizeTrustRoot(
  input: string,
  fileSystem: QualityGateConfiguratorFileSystem,
): string {
  const real = fileSystem.resolveRealPath(input);
  if (real !== undefined) return real;
  try {
    return resolve(input);
  } catch {
    throw new TypeError(`Trust root is not a usable path: ${input}`);
  }
}

function readRecord(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Quality Gate configuration is not an object.');
  }
  return input as Readonly<Record<string, unknown>>;
}

function readRevision(input: unknown): string {
  if (typeof input !== 'string') {
    throw new TypeError('Quality Gate configuration revision is required.');
  }
  if (input.length === 0 || input.length > maximumRevisionLength) {
    throw new TypeError('Quality Gate configuration revision is invalid.');
  }
  if (!/^[a-zA-Z0-9._:-]+$/u.test(input)) {
    throw new TypeError('Quality Gate configuration revision is invalid.');
  }
  return input;
}

function isValidGate(gate: QualityGate): boolean {
  if (!stableGateIdPattern.test(gate.id)) return false;
  if (!Object.values(QualityGateKind).includes(gate.kind)) return false;
  if (!absoluteExecutablePathPattern.test(gate.command.executablePath)) return false;
  if (!Number.isInteger(gate.timeoutMs)) return false;
  if (gate.timeoutMs < minimumTimeoutMs || gate.timeoutMs > maximumTimeoutMs) return false;
  if (gate.command.arguments.length > maximumGateArguments) return false;
  for (const argument of gate.command.arguments) {
    if (typeof argument !== 'string') return false;
    if (argument.length === 0 || argument.length > maximumGateArgumentBytes) return false;
    if (argument.includes('\0')) return false;
  }
  return true;
}

function reviveGate(input: unknown): QualityGate | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Readonly<Record<string, unknown>>;
  if (typeof record.id !== 'string' || !stableGateIdPattern.test(record.id)) return undefined;
  if (typeof record.kind !== 'string') return undefined;
  if (!Object.values(QualityGateKind).includes(record.kind as QualityGate['kind'])) return undefined;
  if (typeof record.executablePath !== 'string') return undefined;
  if (!absoluteExecutablePathPattern.test(record.executablePath)) return undefined;
  if (!Array.isArray(record.arguments)) return undefined;
  if (record.arguments.length > maximumGateArguments) return undefined;
  const argumentsList: string[] = [];
  for (const argument of record.arguments) {
    if (typeof argument !== 'string') return undefined;
    if (argument.length === 0 || argument.length > maximumGateArgumentBytes) return undefined;
    if (argument.includes('\0')) return undefined;
    argumentsList.push(argument);
  }
  if (typeof record.timeoutMs !== 'number') return undefined;
  if (!Number.isInteger(record.timeoutMs)) return undefined;
  if (record.timeoutMs < minimumTimeoutMs || record.timeoutMs > maximumTimeoutMs) return undefined;
  // Reject unknown top-level keys (defence in depth).
  for (const key of Object.keys(record)) {
    if (
      key !== 'id' &&
      key !== 'kind' &&
      key !== 'executablePath' &&
      key !== 'arguments' &&
      key !== 'timeoutMs'
    ) {
      return undefined;
    }
  }
  const gate: QualityGate = Object.freeze({
    command: Object.freeze({
      arguments: Object.freeze(argumentsList),
      executablePath: record.executablePath,
    }),
    id: record.id,
    kind: record.kind as QualityGate['kind'],
    timeoutMs: record.timeoutMs,
  });
  return gate;
}

function success(
  value: QualityGateConfiguration,
): QualityGateConfiguratorResult<QualityGateConfiguration> {
  return Object.freeze({ failure: undefined, value });
}

function failure(
  reason: QualityGateConfiguratorFailure,
): QualityGateConfiguratorResult<QualityGateConfiguration> {
  return Object.freeze({ failure: reason, value: undefined });
}

// Exported for testing.
export const __test = {
  isValidGate,
  reviveGate,
  readRevision,
  readRecord,
  maximumConfigBytes,
  maximumGateArguments,
  maximumGateArgumentBytes,
  maximumTimeoutMs,
  minimumTimeoutMs,
};
