import {
  createApplicationSettings,
  InvalidApplicationSettingsError,
  type AgentExecutableSetting,
  type ApplicationSettings,
} from '@agentterm/domain';

import { ApplicationSettingsConflictError, ApplicationSettingsValidationError } from './errors';
import type {
  AgentCapability,
  AgentCatalog,
  AgentConfigurationInspector,
  ApplicationSettingsRepository,
} from './ports';

export type AgentConfigurationSummary =
  | {
      readonly capabilities: readonly AgentCapability[];
      readonly configuredExecutablePath: string | undefined;
      readonly detectedExecutablePath: string;
      readonly displayName: string;
      readonly id: string;
      readonly kind: 'available';
      readonly version: string | undefined;
    }
  | {
      readonly configuredExecutablePath: string | undefined;
      readonly displayName: string;
      readonly id: string;
      readonly kind: 'unavailable';
      readonly reason: 'EXECUTABLE_NOT_FOUND' | 'INSPECTION_FAILED';
    };

export interface ApplicationSettingsView {
  readonly agents: readonly AgentConfigurationSummary[];
  readonly settings: ApplicationSettings;
}

export interface ApplicationSettingsDependencies {
  readonly catalog: AgentCatalog;
  readonly inspector: AgentConfigurationInspector;
  readonly settings: ApplicationSettingsRepository;
}

export interface UpdateApplicationSettingsInput {
  readonly agentExecutables: readonly AgentExecutableSetting[];
  readonly defaultAgentId: string;
  readonly expectedRevision: number;
  readonly mcpServerToken?: string | undefined;
  readonly terminalFontSize: number;
}

export async function loadApplicationSettings(
  dependencies: ApplicationSettingsDependencies,
): Promise<ApplicationSettingsView> {
  const settings = await dependencies.settings.get();
  return inspectSettings(settings, dependencies);
}

export async function updateApplicationSettings(
  input: UpdateApplicationSettingsInput,
  dependencies: ApplicationSettingsDependencies,
): Promise<ApplicationSettingsView> {
  const current = await dependencies.settings.get();
  if (current.revision !== input.expectedRevision) {
    throw new ApplicationSettingsConflictError();
  }

  let next: ApplicationSettings;
  try {
    next = createApplicationSettings({
      agentExecutables: input.agentExecutables,
      defaultAgentId: input.defaultAgentId,
      ...(input.mcpServerToken === undefined
        ? current.mcpServerToken === undefined
          ? {}
          : { mcpServerToken: current.mcpServerToken }
        : { mcpServerToken: input.mcpServerToken }),
      revision: current.revision + 1,
      terminalFontSize: input.terminalFontSize,
    });
  } catch (error) {
    if (error instanceof InvalidApplicationSettingsError) {
      throw new ApplicationSettingsValidationError('INVALID_SETTINGS', undefined, {
        cause: error,
      });
    }
    throw error;
  }

  assertConfiguredAgent(next.defaultAgentId, dependencies.catalog);
  for (const executable of next.agentExecutables) {
    assertConfiguredAgent(executable.agentId, dependencies.catalog);
    const availability = await dependencies.inspector.inspect({
      agentId: executable.agentId,
      configuredExecutablePath: executable.executablePath,
    });
    if (availability.kind !== 'available') {
      throw new ApplicationSettingsValidationError('EXECUTABLE_NOT_AVAILABLE', executable.agentId);
    }
  }

  await dependencies.settings.update(next, input.expectedRevision);
  return inspectSettings(next, dependencies);
}

async function inspectSettings(
  settings: ApplicationSettings,
  dependencies: ApplicationSettingsDependencies,
): Promise<ApplicationSettingsView> {
  const executableByAgentId = new Map(
    settings.agentExecutables.map((setting) => [setting.agentId, setting.executablePath]),
  );
  const agents = await Promise.all(
    dependencies.catalog.list().map(async (agent): Promise<AgentConfigurationSummary> => {
      const configuredExecutablePath = executableByAgentId.get(agent.identity.id);
      const availability = await dependencies.inspector.inspect({
        agentId: agent.identity.id,
        ...(configuredExecutablePath === undefined ? {} : { configuredExecutablePath }),
      });
      if (availability.kind === 'unavailable') {
        return Object.freeze({
          configuredExecutablePath,
          displayName: agent.identity.displayName,
          id: agent.identity.id,
          kind: availability.kind,
          reason: availability.reason,
        });
      }
      return Object.freeze({
        capabilities: Object.freeze([...availability.capabilities]),
        configuredExecutablePath,
        detectedExecutablePath: availability.executablePath,
        displayName: agent.identity.displayName,
        id: agent.identity.id,
        kind: availability.kind,
        version: availability.version?.raw,
      });
    }),
  );
  return Object.freeze({ agents: Object.freeze(agents), settings });
}

function assertConfiguredAgent(agentId: string, catalog: AgentCatalog): void {
  if (catalog.findById(agentId) === undefined) {
    throw new ApplicationSettingsValidationError('AGENT_NOT_CONFIGURED', agentId);
  }
}
