import {
  type ApplicationSettings,
  type WorkflowPhase,
  type WorkflowPlugin,
} from "@agentterm/domain";

import {
  WorkflowPluginAgentNotConfiguredError,
  WorkflowPluginPhaseNotFoundError,
} from "./errors";
import type { AgentCatalog, AgentIdentity } from "./ports";

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
