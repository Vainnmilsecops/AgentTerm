import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import {
  createWorkflowPlugin,
  InvalidWorkflowPluginError,
  WorkflowPluginPhaseKind,
  type CreateWorkflowPluginInput,
  type WorkflowPlugin,
} from "@agentterm/domain";

import type {
  WorkflowPluginConfiguration,
  WorkflowPluginConfigurator,
  WorkflowPluginConfiguratorResult,
  WorkflowPluginLoadFailure,
} from "@agentterm/application";

const maximumConfigBytes = 128 * 1024;
const maximumRevisionLength = 128;
const maximumStringBytes = 65_536;

export interface WorkflowPluginConfiguratorFileSystem {
  readText(path: string): string | undefined;
  resolveRealPath(path: string): string | undefined;
}

export interface CreateWorkflowPluginConfiguratorOptions {
  readonly fileSystem?: WorkflowPluginConfiguratorFileSystem;
  readonly trustRoots: readonly string[];
}

const defaultFileSystem: WorkflowPluginConfiguratorFileSystem = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
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
};

export function createWorkflowPluginConfigurator(
  options: CreateWorkflowPluginConfiguratorOptions,
): WorkflowPluginConfigurator {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const trustRoots = options.trustRoots.map((root) =>
    normalizeTrustRoot(root, fileSystem),
  );

  const resolveTrustedPath = (path: string): string | undefined => {
    const absolute = isAbsolute(path) ? path : resolve(path);
    const real = fileSystem.resolveRealPath(absolute) ?? absolute;
    const relative = resolvePathInside(real, trustRoots);
    return relative === undefined ? undefined : real;
  };

  return {
    async load(
      input,
    ): Promise<WorkflowPluginConfiguratorResult<WorkflowPluginConfiguration>> {
      const trusted = resolveTrustedPath(input.path);
      if (trusted === undefined) {
        return failure("PATH_NOT_TRUSTED");
      }
      const raw = fileSystem.readText(trusted);
      if (raw === undefined) {
        return failure("PATH_UNREADABLE");
      }
      if (Buffer.byteLength(raw, "utf8") > maximumConfigBytes) {
        return failure("INVALID_FORMAT");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return failure("INVALID_FORMAT");
      }
      const pluginResult = readPluginInput(parsed);
      if (pluginResult.failure !== undefined) {
        return failure(pluginResult.failure);
      }
      const pluginBuild = buildPlugin(pluginResult.value);
      if (pluginBuild.failure !== undefined) {
        return failure(pluginBuild.failure);
      }
      const revisionResult = readRevision(parsed);
      if (revisionResult.failure !== undefined) {
        return failure(revisionResult.failure);
      }
      return success({
        path: trusted,
        plugin: pluginBuild.value,
        revision: revisionResult.value,
      });
    },
  };
}

interface ReaderResult<T> {
  readonly failure: WorkflowPluginLoadFailure | undefined;
  readonly value: T;
}

function ok<T>(value: T): ReaderResult<T> {
  return { failure: undefined, value };
}

function err<T>(reason: WorkflowPluginLoadFailure): ReaderResult<T> {
  return { failure: reason, value: undefined as T };
}

function normalizeTrustRoot(
  root: string,
  fileSystem: WorkflowPluginConfiguratorFileSystem,
): string {
  const absolute = isAbsolute(root) ? root : resolve(root);
  return fileSystem.resolveRealPath(absolute) ?? absolute;
}

function resolvePathInside(
  absolute: string,
  trustRoots: readonly string[],
): string | undefined {
  const normalizedAbsolute = toForwardSlashes(absolute);
  for (const root of trustRoots) {
    const normalizedRoot = toForwardSlashes(root).replace(/\/+$/u, "");
    if (
      normalizedAbsolute === normalizedRoot ||
      normalizedAbsolute.startsWith(`${normalizedRoot}/`)
    ) {
      return normalizedAbsolute;
    }
  }
  return undefined;
}

function toForwardSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function readPluginInput(
  value: unknown,
): ReaderResult<CreateWorkflowPluginInput> {
  if (typeof value !== "object" || value === null) return err("INVALID_FORMAT");
  const record = value as { plugin?: unknown; revision?: unknown };
  const pluginField = record.plugin;
  if (typeof pluginField !== "object" || pluginField === null)
    return err("INVALID_FORMAT");
  const pluginRecord = pluginField as {
    description?: unknown;
    id?: unknown;
    name?: unknown;
    phases?: unknown;
  };
  const idResult = readString(pluginRecord.id);
  if (idResult.failure !== undefined) return err(idResult.failure);
  const nameResult = readString(pluginRecord.name);
  if (nameResult.failure !== undefined) return err(nameResult.failure);
  const descriptionResult = readOptionalString(pluginRecord.description);
  if (descriptionResult.failure !== undefined)
    return err(descriptionResult.failure);
  const phasesRaw = pluginRecord.phases;
  if (!Array.isArray(phasesRaw)) return err("INVALID_FORMAT");
  const phases: CreateWorkflowPluginInput["phases"][number][] = [];
  for (const candidate of phasesRaw) {
    const phase = readPhaseInput(candidate);
    if (phase.failure !== undefined) return err(phase.failure);
    phases.push(phase.value);
  }
  const input: CreateWorkflowPluginInput = {
    id: idResult.value,
    name: nameResult.value,
    phases: phases as CreateWorkflowPluginInput["phases"],
  };
  if (descriptionResult.value !== undefined) {
    (input as { description?: string }).description = descriptionResult.value;
  }
  if (descriptionResult.value !== undefined) {
    Object.assign(input, { description: descriptionResult.value });
  }
  return ok(input);
}

function readRevision(value: unknown): ReaderResult<string> {
  if (typeof value !== "object" || value === null) return err("INVALID_FORMAT");
  const record = value as { revision?: unknown };
  const raw = record.revision;
  if (typeof raw !== "string") return err("INVALID_FORMAT");
  if (raw.length === 0 || raw.length > maximumRevisionLength)
    return err("INVALID_FORMAT");
  return ok(raw);
}

function readPhaseInput(
  value: unknown,
): ReaderResult<CreateWorkflowPluginInput["phases"][number]> {
  if (typeof value !== "object" || value === null) return err("INVALID_FORMAT");
  const record = value as {
    artifactHeading?: unknown;
    artifactKind?: unknown;
    id?: unknown;
    promptTemplate?: unknown;
    requiredHeadings?: unknown;
  };
  const idResult = readString(record.id);
  if (idResult.failure !== undefined) return err(idResult.failure);
  const headingResult = readString(record.artifactHeading);
  if (headingResult.failure !== undefined) return err(headingResult.failure);
  const kindResult = readArtifactKind(record.artifactKind);
  if (kindResult.failure !== undefined) return err(kindResult.failure);
  const promptResult = readOptionalString(record.promptTemplate);
  if (promptResult.failure !== undefined) return err(promptResult.failure);
  const requiredHeadingsRaw = record.requiredHeadings;
  if (!Array.isArray(requiredHeadingsRaw)) return err("INVALID_FORMAT");
  const requiredHeadings: string[] = [];
  for (const heading of requiredHeadingsRaw) {
    const stringResult = readString(heading);
    if (stringResult.failure !== undefined) return err(stringResult.failure);
    requiredHeadings.push(stringResult.value);
  }
  const phase: CreateWorkflowPluginInput["phases"][number] = {
    artifactHeading: headingResult.value,
    artifactKind: kindResult.value,
    id: idResult.value,
    requiredHeadings,
  };
  if (promptResult.value !== undefined) {
    (phase as { promptTemplate?: string }).promptTemplate = promptResult.value;
  }
  return ok(phase);
}

function readArtifactKind(
  value: unknown,
): ReaderResult<keyof typeof WorkflowPluginPhaseKind> {
  if (typeof value !== "string") return err("INVALID_FORMAT");
  if (!Object.keys(WorkflowPluginPhaseKind).includes(value))
    return err("INVALID_FORMAT");
  return ok(value as keyof typeof WorkflowPluginPhaseKind);
}

function readString(value: unknown): ReaderResult<string> {
  if (typeof value !== "string") return err("INVALID_FORMAT");
  if (value.length === 0) return err("INVALID_FORMAT");
  if (Buffer.byteLength(value, "utf8") > maximumStringBytes)
    return err("INVALID_FORMAT");
  return ok(value);
}

function readOptionalString(value: unknown): ReaderResult<string | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (typeof value !== "string") return err("INVALID_FORMAT");
  if (Buffer.byteLength(value, "utf8") > maximumStringBytes)
    return err("INVALID_FORMAT");
  return ok(value);
}

function buildPlugin(
  input: CreateWorkflowPluginInput,
): ReaderResult<WorkflowPlugin> {
  try {
    return ok(createWorkflowPlugin(input));
  } catch (error) {
    if (error instanceof InvalidWorkflowPluginError) {
      return err("INVALID_FORMAT");
    }
    throw error;
  }
}

function success(
  value: WorkflowPluginConfiguration,
): WorkflowPluginConfiguratorResult<WorkflowPluginConfiguration> {
  return Object.freeze({
    failure: undefined,
    value: Object.freeze({
      path: value.path,
      plugin: value.plugin,
      revision: value.revision,
    }),
  });
}

function failure(
  reason: WorkflowPluginLoadFailure,
): WorkflowPluginConfiguratorResult<WorkflowPluginConfiguration> {
  return Object.freeze({ failure: reason, value: undefined });
}
