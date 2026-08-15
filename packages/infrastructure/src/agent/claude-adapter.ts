import type {
  AgentAdapter,
  AgentAvailability,
  AgentLaunchCommand,
  AgentLaunchRequest,
} from '@agentterm/application';

import {
  advertisesResume,
  AgentCliResolutionError,
  executeAgentCliProbe,
  parseAgentVersion,
  resolveAgentCliInvocation,
  resolveAgentLaunchInvocation,
  validateAgentLaunchRequest,
  type AgentCliPackagePolicy,
} from './agent-cli-support';

const CLAUDE_IDENTITY = Object.freeze({ displayName: 'Claude', id: 'claude' });
const RESUME_CAPABILITY = Object.freeze(['SESSION_RESUME'] as const);
const NO_CAPABILITIES = Object.freeze([]);
const CLAUDE_PACKAGE = Object.freeze({
  binName: 'claude',
  binPath: 'bin/claude.exe',
  packageName: '@anthropic-ai/claude-code',
  packagePath: Object.freeze(['@anthropic-ai', 'claude-code']),
  runtime: 'native',
} satisfies AgentCliPackagePolicy);

export class ClaudeAdapter implements AgentAdapter {
  public readonly identity = CLAUDE_IDENTITY;

  public constructor(private readonly configuredExecutable = 'claude') {}

  public async inspect(): Promise<AgentAvailability> {
    let invocation;
    try {
      invocation = await resolveAgentCliInvocation(this.configuredExecutable, CLAUDE_PACKAGE);
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
        /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)? \(Claude Code\)$/u,
      );
      const helpProbe = await executeAgentCliProbe(invocation, ['--help']).catch(() => undefined);
      const capabilities =
        helpProbe?.exitCode === 0 && advertisesResume(helpProbe.stdout)
          ? RESUME_CAPABILITY
          : NO_CAPABILITIES;
      return {
        capabilities,
        executablePath: invocation.identityPath,
        kind: 'available',
        ...(version === undefined ? {} : { version }),
      };
    } catch {
      return { kind: 'unavailable', reason: 'INSPECTION_FAILED' };
    }
  }

  public async buildLaunchCommand(request: AgentLaunchRequest): Promise<AgentLaunchCommand> {
    const invocation = await resolveAgentLaunchInvocation(
      this.configuredExecutable,
      CLAUDE_PACKAGE,
    );
    const validated = await validateAgentLaunchRequest(request, invocation);
    const resumeArguments =
      validated.resumeSessionId === undefined ? [] : ['--resume', validated.resumeSessionId];
    return {
      arguments: [...invocation.prefixArguments, ...resumeArguments],
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
