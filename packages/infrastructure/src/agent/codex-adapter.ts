import type {
  AgentAdapter,
  AgentAvailability,
  AgentLaunchCommand,
  AgentLaunchRequest,
} from '@agentterm/application';

import {
  AgentCliResolutionError,
  executeAgentCliProbe,
  parseAgentVersion,
  resolveAgentCliInvocation,
  resolveAgentLaunchInvocation,
  validateAgentLaunchRequest,
  type AgentCliPackagePolicy,
} from './agent-cli-support';

const CODEX_IDENTITY = Object.freeze({ displayName: 'Codex', id: 'codex' });
const RESUME_CAPABILITY = Object.freeze(['SESSION_RESUME'] as const);
const NO_CAPABILITIES = Object.freeze([]);
const CODEX_PACKAGE = Object.freeze({
  binName: 'codex',
  binPath: 'bin/codex.js',
  packageName: '@openai/codex',
  packagePath: Object.freeze(['@openai', 'codex']),
  runtime: 'node',
} satisfies AgentCliPackagePolicy);

export class CodexAdapter implements AgentAdapter {
  public readonly identity = CODEX_IDENTITY;

  public constructor(private readonly configuredExecutable = 'codex') {}

  public async inspect(): Promise<AgentAvailability> {
    let invocation;
    try {
      invocation = await resolveAgentCliInvocation(this.configuredExecutable, CODEX_PACKAGE);
    } catch (error) {
      return unavailable(error);
    }

    try {
      const versionProbe = await executeAgentCliProbe(invocation, ['--version']);
      if (versionProbe.exitCode !== 0) {
        return { kind: 'unavailable', reason: 'INSPECTION_FAILED' };
      }
      const version = parseAgentVersion(
        versionProbe.stdout,
        /^codex-cli (\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u,
      );
      const resumeProbe = await executeAgentCliProbe(invocation, ['resume', '--help']).catch(
        () => undefined,
      );
      return {
        capabilities: resumeProbe?.exitCode === 0 ? RESUME_CAPABILITY : NO_CAPABILITIES,
        executablePath: invocation.identityPath,
        kind: 'available',
        ...(version === undefined ? {} : { version }),
      };
    } catch {
      return { kind: 'unavailable', reason: 'INSPECTION_FAILED' };
    }
  }

  public async buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    const invocation = await resolveAgentLaunchInvocation(this.configuredExecutable, CODEX_PACKAGE);
    const validated = await validateAgentLaunchRequest(request, invocation);
    const baseArguments = [...invocation.prefixArguments, '--cd', validated.workingDirectory];
    const resumeArguments =
      validated.resumeSessionId === undefined ? [] : ['resume', validated.resumeSessionId];
    return {
      arguments: [...baseArguments, ...resumeArguments],
      environment: validated.environment,
      executablePath: invocation.executablePath,
      workingDirectory: validated.workingDirectory,
    };
  }
}

function unavailable(error: unknown): AgentAvailability {
  return {
    kind: 'unavailable',
    reason:
      error instanceof AgentCliResolutionError && error.reason === 'NOT_FOUND'
        ? 'EXECUTABLE_NOT_FOUND'
        : 'INSPECTION_FAILED',
  };
}
