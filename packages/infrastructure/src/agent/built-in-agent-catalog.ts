import {
  ConfiguredAgentCatalog,
  type AgentAdapter,
  type AgentConfigurationInspector,
} from '@agentterm/application';
import type { ApplicationSettings } from '@agentterm/domain';

import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';
import { GeminiAdapter } from './gemini-adapter';

export interface BuiltInAgentCatalogOptions {
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  readonly geminiExecutable?: string;
}

type AgentAdapterFactory = (configuredExecutable?: string) => AgentAdapter;

const builtInAgentFactories: Readonly<Record<string, AgentAdapterFactory>> = Object.freeze({
  claude: (configuredExecutable) => new ClaudeAdapter(configuredExecutable),
  codex: (configuredExecutable) => new CodexAdapter(configuredExecutable),
  gemini: (configuredExecutable) => new GeminiAdapter(configuredExecutable),
});

export function createBuiltInAgentCatalog(
  options: BuiltInAgentCatalogOptions = {},
): ConfiguredAgentCatalog {
  return new ConfiguredAgentCatalog([
    new CodexAdapter(options.codexExecutable),
    new ClaudeAdapter(options.claudeExecutable),
    new GeminiAdapter(options.geminiExecutable),
  ]);
}

export function createBuiltInAgentCatalogFromSettings(
  settings: ApplicationSettings,
): ConfiguredAgentCatalog {
  const executableByAgentId = new Map(
    settings.agentExecutables.map(({ agentId, executablePath }) => [agentId, executablePath]),
  );
  const claudeExecutable = executableByAgentId.get('claude');
  const codexExecutable = executableByAgentId.get('codex');
  const geminiExecutable = executableByAgentId.get('gemini');
  return createBuiltInAgentCatalog({
    ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(geminiExecutable === undefined ? {} : { geminiExecutable }),
  });
}

export class BuiltInAgentConfigurationInspector implements AgentConfigurationInspector {
  public async inspect(input: {
    readonly agentId: string;
    readonly configuredExecutablePath?: string;
  }) {
    const factory = builtInAgentFactories[input.agentId];
    if (factory === undefined) {
      return { kind: 'unavailable' as const, reason: 'INSPECTION_FAILED' as const };
    }
    return factory(input.configuredExecutablePath).inspect();
  }
}
