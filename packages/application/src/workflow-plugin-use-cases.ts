import {
  TaskPhase,
  type ApplicationSettings,
  type WorkflowPhase,
  type WorkflowPlugin,
} from "@agentterm/domain";

import {
  AgentNotConfiguredError,
  WorkflowPluginAgentNotConfiguredError,
  WorkflowPluginPhaseNotFoundError,
} from "./errors";
import { WorkflowPluginConfiguratorError } from "./workflow-plugin-loader";
import type {
  AgentCatalog,
  AgentIdentity,
  ApplicationSettingsRepository,
  WorkflowPluginBindingRepository,
  WorkflowPluginConfigurator,
  WorkflowPluginConfiguratorResult,
} from "./ports";

export interface BindPhaseAgentInput {
  readonly phaseId: string;
  readonly plugin: WorkflowPlugin;
  readonly settings: ApplicationSettings;
}

export interface SelectArtifactContractInput {
  readonly phaseId: string;
  readonly plugin: WorkflowPlugin;
}

/**
 * Resolves the {@link AgentIdentity} used for one phase of one plugin by
 * choosing the first available catalog agent that the phase allows, falling
 * back to the Settings default agent when the phase allows any identity.
 *
 * The mapping is deterministic so the same Settings revision and the same
 * catalog order produce the same selection; the renderer never invents the
 * identity and the application never adopts a non-allowed agent.
 */
export function bindPhaseAgent(
  input: BindPhaseAgentInput,
  catalog: AgentCatalog,
): AgentIdentity {
  const phase = findPhase(input.plugin, input.phaseId);
  const allowed = phase.kickoff.allowedAgents;
  const candidates = catalog.list();
  for (const adapter of candidates) {
    if (allowed.length === 0 || allowed.includes(adapter.identity.id)) {
      return adapter.identity;
    }
  }
  if (allowed.length > 0) {
    const fallback = candidates.find(
      (adapter) => adapter.identity.id === input.settings.defaultAgentId,
    );
    if (fallback && allowed.includes(fallback.identity.id)) {
      return fallback.identity;
    }
    throw new WorkflowPluginAgentNotConfiguredError(
      input.phaseId,
      input.plugin.id,
    );
  }
  const defaultAgent = candidates.find(
    (adapter) => adapter.identity.id === input.settings.defaultAgentId,
  );
  if (!defaultAgent) {
    throw new WorkflowPluginAgentNotConfiguredError(
      input.phaseId,
      input.plugin.id,
    );
  }
  return defaultAgent.identity;
}

export interface WorkflowPhaseArtifactProjection {
  readonly canonicalName: string;
  readonly heading: string;
  readonly phase: WorkflowPhase["taskPhase"];
}

export function selectPhaseArtifactContract(
  input: SelectArtifactContractInput,
): WorkflowPhaseArtifactProjection {
  const phase = findPhase(input.plugin, input.phaseId);
  return Object.freeze({
    canonicalName: phase.artifactContract.canonicalName,
    heading: phase.artifactContract.heading,
    phase: phase.taskPhase,
  });
}

function findPhase(plugin: WorkflowPlugin, phaseId: string): WorkflowPhase {
  for (const phase of plugin.phases) {
    if (phase.id === phaseId) {
      return phase;
    }
  }
  throw new WorkflowPluginPhaseNotFoundError(plugin.id, phaseId);
}

/**
 * Resolves the coding-agent identity for a Task execution attempt.
 *
 * Precedence:
 *  1. Explicit `requestedAgentId` from the caller — always honored when
 *     supplied.
 *  2. Workflow Plugin binding looked up via the optional `pluginBindings`
 *     repository. When found, the agent is picked through
 *     {@link bindPhaseAgent} using the phase id that maps to the expected
 *     TaskPhase (`'planning'` → `TaskPhase.PLANNING`, `'running'` →
 *     `TaskPhase.RUNNING`, `'research'` → `TaskPhase.BACKLOG`).
 *  3. No binding and no explicit agent — throws `AgentNotConfiguredError`
 *     so the renderer knows it must surface an explicit agent selection.
 *
 * The resolver intentionally never inspects the catalog for a "best match"
 * when a binding is present; that decision is fully owned by
 * `bindPhaseAgent` so the Domain shape stays the single source of truth.
 */
export async function resolveAgentForTask(
  taskId: string,
  requestedAgentId: string | undefined,
  expectedPhase: typeof TaskPhase.BACKLOG | typeof TaskPhase.PLANNING | typeof TaskPhase.RUNNING,
  dependencies: {
    readonly agents?: AgentCatalog;
    readonly applicationSettings?: ApplicationSettingsRepository;
    readonly pluginBindings?: WorkflowPluginBindingRepository;
    readonly sessionCoordinator: Pick<import('./agent-session-coordinator').AgentSessionCoordinator, 'isAgentConfigured' | 'listByTaskId'>;
    readonly workflowPluginConfigurator?: WorkflowPluginConfigurator;
  },
): Promise<string> {
  if (requestedAgentId !== undefined && requestedAgentId.length > 0) {
    return requestedAgentId;
  }
  const { pluginBindings, workflowPluginConfigurator, agents } = dependencies;
  if (
    pluginBindings === undefined ||
    workflowPluginConfigurator === undefined ||
    agents === undefined
  ) {
    throw new AgentNotConfiguredError('default');
  }
  const binding = await pluginBindings.findByTaskId(taskId);
  if (binding === undefined) {
    throw new AgentNotConfiguredError('default');
  }
  const loaded: WorkflowPluginConfiguratorResult<import('./ports').WorkflowPluginConfiguration> = await workflowPluginConfigurator.load({ path: binding.sourcePath });
  if (loaded.failure !== undefined) {
    throw new WorkflowPluginConfiguratorError(loaded.failure);
  }
  if (loaded.value === undefined) {
    throw new WorkflowPluginConfiguratorError('INVALID_FORMAT');
  }
  const settings: ApplicationSettings =
    (await dependencies.applicationSettings?.get()) ?? { agentExecutables: [], allowClipboardReadWrite: false, defaultAgentId: 'codex', mcpServerToken: undefined, revision: 0, schemaVersion: 2, terminalFontSize: 14 };
  const phaseId = phaseIdFor(expectedPhase);
  const agent = bindPhaseAgent({ phaseId, plugin: loaded.value.plugin, settings }, agents);
  return agent.id;
}

/** Maps a TaskPhase to its corresponding plugin phase id string. */
function phaseIdFor(phase: typeof TaskPhase.BACKLOG | typeof TaskPhase.PLANNING | typeof TaskPhase.RUNNING): string {
  switch (phase) {
    case TaskPhase.BACKLOG: return 'research';
    case TaskPhase.PLANNING: return 'planning';
    case TaskPhase.RUNNING: return 'running';
  }
}

// Re-export for convenience so task-execution.ts can use it
export { findPhase };
