import type { WorkflowPlugin } from "@agentterm/domain";

import {
  WorkflowPluginConflictError,
  WorkflowPluginValidationError,
} from "./errors";
import type {
  WorkflowPluginBindingRecord,
  WorkflowPluginBindingRepository,
  WorkflowPluginConfiguration,
  WorkflowPluginConfigurator,
  WorkflowPluginConfiguratorResult,
  WorkflowPluginLoadFailure,
} from "./ports";

export interface InstallWorkflowPluginInput {
  /** Path of the trusted plugin file. */
  readonly path: string;
  /** Required first-install revision; pass `0` for the initial install. */
  readonly expectedRevision: number;
  /** Task for which the plugin is installed. */
  readonly taskId: string;
}

export interface RemoveWorkflowPluginBindingInput {
  /**
   * Revision the caller expects to be persisted before the removal. Pass
   * the binding's current revision so concurrent windows cannot silently
   * race a remove against an install in another surface.
   */
  readonly expectedRevision: number;
  /** Task whose plugin binding is being removed. */
  readonly taskId: string;
}

export interface RemoveWorkflowPluginBindingResult {
  readonly pluginId: string;
  /** Wall-clock timestamp the main process recorded during the removal. */
  readonly removedAt: number;
  /** Revision the binding carried immediately before removal. */
  readonly revision: number;
  readonly sourcePath: string;
}

export interface InstallWorkflowPluginDependencies {
  readonly bindingRepository: WorkflowPluginBindingRepository & {
    upsert(
      record: WorkflowPluginBindingRecord,
      expectedRevision: number,
    ): Promise<void>;
  };
  readonly configurator: WorkflowPluginConfigurator;
  readonly now: () => number;
}

export interface RemoveWorkflowPluginBindingDependencies {
  readonly bindingRepository: WorkflowPluginBindingRepository & {
    removeByTaskId(taskId: string): Promise<boolean>;
  };
  readonly now: () => number;
}

export interface InstallWorkflowPluginResult {
  readonly binding: WorkflowPluginBindingRecord;
  readonly plugin: WorkflowPlugin;
}

export type InstallWorkflowPluginFailure =
  | "CONFLICT"
  | "NO_BINDING_EXISTS_FOR_EXPECTED_REVISION"
  | WorkflowPluginLoadFailure;

export type RemoveWorkflowPluginBindingFailure =
  | "CONFLICT"
  | "NOT_FOUND";

export class InstallWorkflowPluginError extends Error {
  public readonly reason: InstallWorkflowPluginFailure;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    reason: InstallWorkflowPluginFailure,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(installMessage(reason, details));
    this.name = "InstallWorkflowPluginError";
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

export class RemoveWorkflowPluginBindingError extends Error {
  public readonly reason: RemoveWorkflowPluginBindingFailure;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    reason: RemoveWorkflowPluginBindingFailure,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(removeMessage(reason, details));
    this.name = "RemoveWorkflowPluginBindingError";
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

export class WorkflowPluginConfiguratorError extends Error {
  public readonly reason: WorkflowPluginLoadFailure;

  public constructor(reason: WorkflowPluginLoadFailure) {
    super(installMessage(reason, {}));
    this.name = "WorkflowPluginConfiguratorError";
    this.reason = reason;
  }
}

/**
 * Loads a plugin file via the trusted configurator and persists the binding
 * for one Task using compare-and-set semantics.
 *
 * When `expectedRevision` is `0`, no prior binding may exist. For any other
 * value, the existing binding must carry that exact revision; concurrent
 * writers must reload and retry.
 */
export async function installWorkflowPluginForTask(
  input: InstallWorkflowPluginInput,
  dependencies: InstallWorkflowPluginDependencies,
): Promise<InstallWorkflowPluginResult> {
  const loaded = await dependencies.configurator.load({ path: input.path });
  if (loaded.failure !== undefined) {
    throw new WorkflowPluginConfiguratorError(loaded.failure);
  }
  const configuration = expectConfiguration(loaded);

  const existing = await dependencies.bindingRepository.findByTaskId(
    input.taskId,
  );
  if (input.expectedRevision === 0) {
    if (existing !== undefined) {
      throw new InstallWorkflowPluginError("CONFLICT", {
        expectedRevision: input.expectedRevision,
        existingRevision: existing.revision,
      });
    }
  } else if (
    existing === undefined ||
    existing.revision !== input.expectedRevision
  ) {
    throw new WorkflowPluginConflictError();
  }

  const nextRevision = (existing?.revision ?? 0) + 1;
  const binding: WorkflowPluginBindingRecord = Object.freeze({
    activePhaseId: configuration.plugin.phases[0]?.id ?? "",
    installedAt: dependencies.now(),
    pluginId: configuration.plugin.id,
    revision: nextRevision,
    sourcePath: configuration.path,
    taskId: input.taskId,
  });

  try {
    await dependencies.bindingRepository.upsert(
      binding,
      input.expectedRevision,
    );
  } catch (error) {
    if (error instanceof WorkflowPluginConflictError) {
      throw new InstallWorkflowPluginError("CONFLICT", {
        expectedRevision: input.expectedRevision,
      });
    }
    if (error instanceof WorkflowPluginValidationError) {
      throw new InstallWorkflowPluginError("UNKNOWN_PLUGIN", {
        details: error.details,
      });
    }
    throw error;
  }

  return Object.freeze({ binding, plugin: configuration.plugin });
}

/**
 * Removes a Workflow Plugin binding for one Task using compare-and-set
 * semantics. The repository is the only writer; this use case is the
 * single Application entry point so the renderer never mutates bindings
 * directly.
 *
 * The `expectedRevision` argument must equal the binding's current
 * revision. A mismatch surfaces as `RemoveWorkflowPluginBindingError`
 * with reason `'CONFLICT'` so the caller can reload and retry. A missing
 * binding surfaces as `'NOT_FOUND'`.
 */
export async function removeWorkflowPluginBindingForTask(
  input: RemoveWorkflowPluginBindingInput,
  dependencies: RemoveWorkflowPluginBindingDependencies,
): Promise<RemoveWorkflowPluginBindingResult> {
  const existing = await dependencies.bindingRepository.findByTaskId(
    input.taskId,
  );
  if (existing === undefined) {
    throw new RemoveWorkflowPluginBindingError("NOT_FOUND", {
      taskId: input.taskId,
    });
  }
  if (existing.revision !== input.expectedRevision) {
    throw new RemoveWorkflowPluginBindingError("CONFLICT", {
      existingRevision: existing.revision,
      expectedRevision: input.expectedRevision,
    });
  }

  const removed = await dependencies.bindingRepository.removeByTaskId(
    input.taskId,
  );
  if (!removed) {
    // The binding disappeared between the read and the delete. Surface
    // this as a `NOT_FOUND` so the caller can refresh its local mirror.
    throw new RemoveWorkflowPluginBindingError("NOT_FOUND", {
      taskId: input.taskId,
    });
  }

  return Object.freeze({
    pluginId: existing.pluginId,
    removedAt: dependencies.now(),
    revision: existing.revision,
    sourcePath: existing.sourcePath,
  });
}

function expectConfiguration(
  result: WorkflowPluginConfiguratorResult<WorkflowPluginConfiguration>,
): WorkflowPluginConfiguration {
  if (result.failure !== undefined) {
    throw new WorkflowPluginConfiguratorError(result.failure);
  }
  if (result.value === undefined) {
    throw new WorkflowPluginConfiguratorError("INVALID_FORMAT");
  }
  return result.value;
}

function installMessage(
  reason: WorkflowPluginLoadFailure | InstallWorkflowPluginFailure,
  details: Readonly<Record<string, unknown>>,
): string {
  switch (reason) {
    case "CONFLICT":
      return "The Workflow Plugin binding changed in another window. Reload it and try again.";
    case "NO_BINDING_EXISTS_FOR_EXPECTED_REVISION":
      return "The Workflow Plugin binding is missing for the expected revision.";
    case "INVALID_FORMAT":
      return "The Workflow Plugin file is malformed.";
    case "PATH_NOT_TRUSTED":
      return "The Workflow Plugin file is outside the configured trust root.";
    case "PATH_UNREADABLE":
      return "The Workflow Plugin file could not be read.";
    case "UNKNOWN_PLUGIN":
      return "The Workflow Plugin declared an unknown or unsupported plugin identifier.";
    default:
      return `Workflow Plugin operation failed (${reason})`;
  }
  void details;
}

function removeMessage(
  reason: RemoveWorkflowPluginBindingFailure,
  details: Readonly<Record<string, unknown>>,
): string {
  switch (reason) {
    case "CONFLICT":
      return "The Workflow Plugin binding changed in another window. Reload it and try again.";
    case "NOT_FOUND":
      return "No Workflow Plugin binding is installed for this task.";
    default:
      return `Workflow Plugin removal failed (${reason})`;
  }
  void details;
}
