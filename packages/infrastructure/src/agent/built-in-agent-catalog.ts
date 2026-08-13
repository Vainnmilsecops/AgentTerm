import { ConfiguredAgentCatalog } from '@agentterm/application';

import { ClaudeAdapter } from './claude-adapter';
import { CodexAdapter } from './codex-adapter';
import { GeminiAdapter } from './gemini-adapter';

export interface BuiltInAgentCatalogOptions {
  readonly claudeExecutable?: string;
  readonly codexExecutable?: string;
  readonly geminiExecutable?: string;
}

export function createBuiltInAgentCatalog(
  options: BuiltInAgentCatalogOptions = {},
): ConfiguredAgentCatalog {
  return new ConfiguredAgentCatalog([
    new CodexAdapter(options.codexExecutable),
    new ClaudeAdapter(options.claudeExecutable),
    new GeminiAdapter(options.geminiExecutable),
  ]);
}
