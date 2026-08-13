export const ApplicationSettingsDefaults = Object.freeze({
  defaultAgentId: 'codex',
  terminalFontSize: 14,
});

export interface AgentExecutableSetting {
  readonly agentId: string;
  readonly executablePath: string;
}

export interface ApplicationSettings {
  readonly agentExecutables: readonly AgentExecutableSetting[];
  readonly defaultAgentId: string;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly terminalFontSize: number;
}

export interface CreateApplicationSettingsInput {
  readonly agentExecutables?: readonly AgentExecutableSetting[];
  readonly defaultAgentId?: string;
  readonly revision?: number;
  readonly schemaVersion?: 1;
  readonly terminalFontSize?: number;
}

export type InvalidApplicationSettingsReason =
  | 'DUPLICATE_AGENT'
  | 'INVALID_AGENT_ID'
  | 'INVALID_EXECUTABLE'
  | 'INVALID_REVISION'
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_TERMINAL_FONT_SIZE';

export class InvalidApplicationSettingsError extends Error {
  public constructor(public readonly reason: InvalidApplicationSettingsReason) {
    super(messageForReason(reason));
    this.name = 'InvalidApplicationSettingsError';
  }
}

const stableAgentIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const maximumAgentIdLength = 64;
const maximumExecutableLength = 32_768;
const minimumTerminalFontSize = 8;
const maximumTerminalFontSize = 32;

export function createApplicationSettings(
  input: CreateApplicationSettingsInput = {},
): ApplicationSettings {
  const revision = input.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new InvalidApplicationSettingsError('INVALID_REVISION');
  }

  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    throw new InvalidApplicationSettingsError('INVALID_SCHEMA_VERSION');
  }

  const defaultAgentId = validateAgentId(
    input.defaultAgentId ?? ApplicationSettingsDefaults.defaultAgentId,
  );
  const terminalFontSize = input.terminalFontSize ?? ApplicationSettingsDefaults.terminalFontSize;
  if (
    !Number.isInteger(terminalFontSize) ||
    terminalFontSize < minimumTerminalFontSize ||
    terminalFontSize > maximumTerminalFontSize
  ) {
    throw new InvalidApplicationSettingsError('INVALID_TERMINAL_FONT_SIZE');
  }

  const seenAgentIds = new Set<string>();
  const agentExecutables = (input.agentExecutables ?? [])
    .map((setting) => {
      const agentId = validateAgentId(setting.agentId);
      if (seenAgentIds.has(agentId)) {
        throw new InvalidApplicationSettingsError('DUPLICATE_AGENT');
      }
      seenAgentIds.add(agentId);

      const executablePath = setting.executablePath.trim();
      if (
        executablePath.length === 0 ||
        executablePath.length > maximumExecutableLength ||
        executablePath.includes('\0')
      ) {
        throw new InvalidApplicationSettingsError('INVALID_EXECUTABLE');
      }
      return Object.freeze({ agentId, executablePath });
    })
    .sort((left, right) =>
      left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0,
    );

  return Object.freeze({
    agentExecutables: Object.freeze(agentExecutables),
    defaultAgentId,
    revision,
    schemaVersion: 1 as const,
    terminalFontSize,
  });
}

function validateAgentId(value: string): string {
  const id = value.trim();
  if (id.length > maximumAgentIdLength || !stableAgentIdPattern.test(id)) {
    throw new InvalidApplicationSettingsError('INVALID_AGENT_ID');
  }
  return id;
}

function messageForReason(reason: InvalidApplicationSettingsReason): string {
  switch (reason) {
    case 'DUPLICATE_AGENT':
      return 'Application Settings contain a duplicate agent executable override.';
    case 'INVALID_AGENT_ID':
      return 'Application Settings contain an invalid stable agent identifier.';
    case 'INVALID_EXECUTABLE':
      return 'An agent executable override is invalid.';
    case 'INVALID_REVISION':
      return 'Application Settings revision is invalid.';
    case 'INVALID_SCHEMA_VERSION':
      return 'Application Settings schema version is unsupported.';
    case 'INVALID_TERMINAL_FONT_SIZE':
      return 'Terminal font size must be an integer from 8 through 32.';
  }
}
