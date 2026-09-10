import type { WorkflowPlugin } from "@agentterm/domain";
import { WorkflowPluginPhaseKind } from "@agentterm/domain";

import {
  WorkflowPluginConflictError,
  WorkflowPluginValidationError,
} from "./errors";
import type {
  ExecutionArtifactRepository,
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

export interface UpdateWorkflowPluginBindingInput {
  /**
   * Revision the caller expects to be persisted before the update.
   * Same compare-and-set semantics as install and remove so concurrent
   * windows cannot silently overwrite one another.
   */
  readonly expectedRevision: number;
  /**
   * Path of the new trusted plugin file. The configurator re-parses
   * and re-validates it; failure surfaces as the install-side error
   * classes (`WorkflowPluginConfiguratorError`,
   * `WorkflowPluginUpdateError`).
   */
  readonly path: string;
  readonly taskId: string;
}

export interface UpdateWorkflowPluginBindingResult {
  readonly binding: WorkflowPluginBindingRecord;
  readonly plugin: WorkflowPlugin;
}

export type UpdateWorkflowPluginBindingFailure =
  | "CONFLICT"
  | "INVALID_PHASE_FOR_PLUGIN"
  | "UNKNOWN_PLUGIN"
  | WorkflowPluginLoadFailure;

export interface UpdateWorkflowPluginDependencies {
  readonly bindingRepository: WorkflowPluginBindingRepository & {
    upsert(
      record: WorkflowPluginBindingRecord,
      expectedRevision: number,
    ): Promise<void>;
  };
  readonly configurator: WorkflowPluginConfigurator;
  readonly now: () => number;
}

export class WorkflowPluginUpdateError extends Error {
  public readonly reason: UpdateWorkflowPluginBindingFailure;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    reason: UpdateWorkflowPluginBindingFailure,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(updateMessage(reason, details));
    this.name = "WorkflowPluginUpdateError";
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

export interface AdvanceActivePhaseInput {
  /**
   * Direction. `'next'` and `'previous'` resolve against the plugin's
   * declared phase list; `'set'` requires an explicit `phaseId`.
   */
  readonly direction: "next" | "previous" | "set";
  readonly expectedRevision: number;
  /**
   * Bypass the artifact-already-recorded guard. Set by an explicit
   * renderer action ("Force skip phase") rather than the default
   * advance control so accidental clicks cannot lose audit-trail
   * evidence.
   */
  readonly force?: boolean;
  readonly phaseId?: string;
  readonly taskId: string;
}

export interface AdvanceActivePhaseResult {
  readonly activePhaseId: string;
  readonly binding: WorkflowPluginBindingRecord;
  /** Projected per-phase agent using the existing `bindPhaseAgent` use case. */
  readonly phaseAgentId: string | undefined;
  readonly pluginId: string;
}

export type AdvanceActivePhaseFailure =
  | "ARTIFACT_ALREADY_RECORDED"
  | "BOUNDARY_REACHED"
  | "CONFLICT"
  | "INVALID_PHASE_FOR_PLUGIN"
  | "NOT_FOUND";

export interface AdvanceActivePhaseDependencies {
  readonly agents: ExecutionArtifactAgentsByKindRepository;
  readonly artifactRepository: ExecutionArtifactRepository;
  readonly bindingRepository: WorkflowPluginBindingRepository & {
    upsert(
      record: WorkflowPluginBindingRecord,
      expectedRevision: number,
    ): Promise<void>;
    removeByTaskId(taskId: string): Promise<boolean>;
  };
  readonly configurator: WorkflowPluginConfigurator;
  readonly now: () => number;
  readonly settings: () => {
    readonly defaultAgentId: string | undefined;
    readonly executableOverrides: Readonly<Record<string, string>>;
  };
}

export class AdvanceActivePhaseError extends Error {
  public readonly reason: AdvanceActivePhaseFailure;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    reason: AdvanceActivePhaseFailure,
    details: Readonly<Record<string, unknown>>,
  ) {
    super(advanceMessage(reason, details));
    this.name = "AdvanceActivePhaseError";
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

interface ExecutionArtifactAgentsByKindRepository {
  /**
   * Returns the agent id selected by `bindPhaseAgent` for a given
   * phase. Returns `undefined` when the catalog cannot resolve a
   * match — the projection still succeeds with an empty agent id.
   */
  resolveForPhase(input: {
    readonly plugin: WorkflowPlugin;
    readonly phaseId: string;
    readonly settings: {
      readonly defaultAgentId: string | undefined;
      readonly executableOverrides: Readonly<Record<string, string>>;
    };
  }): Promise<string | undefined> | string | undefined;
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

/**
 * Switches the Workflow Plugin binding for one Task to a different
 * trusted plugin file, preserving the same compare-and-set semantics
 * as install and remove. The active phase is preserved when the new
 * plugin exposes the same phase id; otherwise the call refuses with
 * `INVALID_PHASE_FOR_PLUGIN` so the caller can decide explicitly.
 */
export async function updateWorkflowPluginBindingForTask(
  input: UpdateWorkflowPluginBindingInput,
  dependencies: UpdateWorkflowPluginDependencies,
): Promise<UpdateWorkflowPluginBindingResult> {
  const loaded = await dependencies.configurator.load({ path: input.path });
  if (loaded.failure !== undefined) {
    throw new WorkflowPluginConfiguratorError(loaded.failure);
  }
  const configuration = expectConfiguration(loaded);

  const existing = await dependencies.bindingRepository.findByTaskId(
    input.taskId,
  );
  if (existing === undefined) {
    throw new WorkflowPluginUpdateError("CONFLICT", {
      reason: "NO_BINDING_EXISTS",
      taskId: input.taskId,
    });
  }
  if (existing.revision !== input.expectedRevision) {
    throw new WorkflowPluginConflictError();
  }

  const phaseIds = new Set(configuration.plugin.phases.map((p) => p.id));
  if (!phaseIds.has(existing.activePhaseId)) {
    throw new WorkflowPluginUpdateError("INVALID_PHASE_FOR_PLUGIN", {
      activePhaseId: existing.activePhaseId,
      pluginId: configuration.plugin.id,
    });
  }

  const nextRevision = existing.revision + 1;
  const binding: WorkflowPluginBindingRecord = Object.freeze({
    activePhaseId: existing.activePhaseId,
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
      throw new WorkflowPluginUpdateError("CONFLICT", {
        expectedRevision: input.expectedRevision,
      });
    }
    if (error instanceof WorkflowPluginValidationError) {
      throw new WorkflowPluginUpdateError("UNKNOWN_PLUGIN", {
        details: error.details,
      });
    }
    throw error;
  }

  return Object.freeze({ binding, plugin: configuration.plugin });
}

/**
 * Moves the active phase forward, backward, or to an explicit id on a
 * bound Task. Refuses to skip a phase that already produced an
 * `ExecutionArtifact` for the Task unless `force` is true.
 */
export async function advanceActivePhaseForTask(
  input: AdvanceActivePhaseInput,
  dependencies: AdvanceActivePhaseDependencies,
): Promise<AdvanceActivePhaseResult> {
  const existing = await dependencies.bindingRepository.findByTaskId(
    input.taskId,
  );
  if (existing === undefined) {
    throw new AdvanceActivePhaseError("NOT_FOUND", { taskId: input.taskId });
  }
  if (existing.revision !== input.expectedRevision) {
    throw new WorkflowPluginConflictError();
  }

  const loaded = await dependencies.configurator.load({
    path: existing.sourcePath,
  });
  if (loaded.failure !== undefined) {
    throw new WorkflowPluginUpdateError("UNKNOWN_PLUGIN", {
      reason: "STORED_PLUGIN_FAILED_TO_LOAD",
      sourcePath: existing.sourcePath,
    });
  }
  const configuration = expectConfiguration(loaded);
  const phases = configuration.plugin.phases;
  const currentIndex = phases.findIndex((p) => p.id === existing.activePhaseId);
  if (currentIndex === -1) {
    throw new AdvanceActivePhaseError("INVALID_PHASE_FOR_PLUGIN", {
      activePhaseId: existing.activePhaseId,
      pluginId: configuration.plugin.id,
    });
  }

  let nextIndex: number;
  if (input.direction === "next") {
    nextIndex = currentIndex + 1;
    if (nextIndex >= phases.length) {
      throw new AdvanceActivePhaseError("BOUNDARY_REACHED", {
        direction: input.direction,
        taskId: input.taskId,
      });
    }
  } else if (input.direction === "previous") {
    nextIndex = currentIndex - 1;
    if (nextIndex < 0) {
      throw new AdvanceActivePhaseError("BOUNDARY_REACHED", {
        direction: input.direction,
        taskId: input.taskId,
      });
    }
  } else {
    const explicitId = input.phaseId;
    if (explicitId === undefined || explicitId.length === 0) {
      throw new AdvanceActivePhaseError("INVALID_PHASE_FOR_PLUGIN", {
        reason: "MISSING_PHASE_ID",
      });
    }
    const foundIndex = phases.findIndex((p) => p.id === explicitId);
    if (foundIndex === -1) {
      throw new AdvanceActivePhaseError("INVALID_PHASE_FOR_PLUGIN", {
        reason: "UNKNOWN_PHASE_ID",
        phaseId: explicitId,
      });
    }
    nextIndex = foundIndex;
  }

  const targetPhase = phases[nextIndex];
  if (targetPhase === undefined) {
    throw new AdvanceActivePhaseError("INVALID_PHASE_FOR_PLUGIN", {
      nextIndex,
    });
  }

  // Forward jumps can lose audit-trail evidence, so they require
  // `force: true` whenever a phase artifact is already recorded.
  const forwardJump = nextIndex > currentIndex;
  if (forwardJump && input.force !== true) {
    const recorded = await dependencies.artifactRepository.findLatestByTaskIdAndKind(
      input.taskId,
      phaseKindToArtifactKind(targetPhase.artifactContract.kind),
    );
    if (recorded !== undefined) {
      throw new AdvanceActivePhaseError("ARTIFACT_ALREADY_RECORDED", {
        artifactId: recorded.id,
        artifactKind: recorded.kind,
        phaseId: targetPhase.id,
        taskId: input.taskId,
      });
    }
  }

  const nextRevision = existing.revision + 1;
  const binding: WorkflowPluginBindingRecord = Object.freeze({
    activePhaseId: targetPhase.id,
    installedAt: dependencies.now(),
    pluginId: configuration.plugin.id,
    revision: nextRevision,
    sourcePath: existing.sourcePath,
    taskId: input.taskId,
  });

  try {
    await dependencies.bindingRepository.upsert(
      binding,
      input.expectedRevision,
    );
  } catch (error) {
    if (error instanceof WorkflowPluginConflictError) {
      throw new AdvanceActivePhaseError("CONFLICT", {
        expectedRevision: input.expectedRevision,
      });
    }
    throw error;
  }

  const phaseAgentId = await dependencies.agents.resolveForPhase({
    plugin: configuration.plugin,
    phaseId: targetPhase.id,
    settings: dependencies.settings(),
  });

  return Object.freeze({
    activePhaseId: targetPhase.id,
    binding,
    phaseAgentId: phaseAgentId ?? undefined,
    pluginId: configuration.plugin.id,
  });
}

function phaseKindToArtifactKind(
  kind: WorkflowPluginPhaseKind,
): "plan" | "research" | "review" | "execution-summary" {
  switch (kind) {
    case "planning":
      return "plan";
    case "research":
      return "research";
    case "review":
      return "review";
    case "running":
      return "execution-summary";
    default:
      // Exhaustiveness check: WorkflowPluginPhaseKind is a closed union.
      throw new Error(
        `Unsupported WorkflowPlugin phase kind: ${String(kind)}`,
      );
  }
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

function updateMessage(
  reason: UpdateWorkflowPluginBindingFailure,
  details: Readonly<Record<string, unknown>>,
): string {
  switch (reason) {
    case "CONFLICT":
      return "The Workflow Plugin binding changed in another window. Reload it and try again.";
    case "INVALID_PHASE_FOR_PLUGIN":
      return "The current active phase is not declared by the new plugin file.";
    case "UNKNOWN_PLUGIN":
      return "The Workflow Plugin declared an unknown or unsupported plugin identifier.";
    case "INVALID_FORMAT":
      return "The Workflow Plugin file is malformed.";
    case "PATH_NOT_TRUSTED":
      return "The Workflow Plugin file is outside the configured trust root.";
    case "PATH_UNREADABLE":
      return "The Workflow Plugin file could not be read.";
    default:
      return `Workflow Plugin update failed (${reason})`;
  }
  void details;
}

function advanceMessage(
  reason: AdvanceActivePhaseFailure,
  details: Readonly<Record<string, unknown>>,
): string {
  switch (reason) {
    case "CONFLICT":
      return "The Workflow Plugin binding changed in another window. Reload it and try again.";
    case "NOT_FOUND":
      return "No Workflow Plugin binding is installed for this task.";
    case "INVALID_PHASE_FOR_PLUGIN":
      return "The selected phase is not declared by the bound Workflow Plugin.";
    case "BOUNDARY_REACHED":
      return "The active phase cannot move further in that direction.";
    case "ARTIFACT_ALREADY_RECORDED":
      return "An artifact is already recorded for the target phase; use force to skip it.";
    default:
      return `Workflow Plugin phase advance failed (${reason})`;
  }
  void details;
}
