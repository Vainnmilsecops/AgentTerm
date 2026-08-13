import type {
  AgentAdapter,
  AgentAvailability,
  AgentLaunchCommand,
  AgentLaunchRequest,
} from '@agentterm/application';
import { AgentAdapterError } from '@agentterm/application';

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

const GEMINI_IDENTITY = Object.freeze({ displayName: 'Gemini', id: 'gemini' });
const RESUME_CAPABILITY = Object.freeze(['SESSION_RESUME'] as const);
const NO_CAPABILITIES = Object.freeze([]);
const GEMINI_PACKAGE = Object.freeze({
  binName: 'gemini',
  binPath: 'bundle/gemini.js',
  packageName: '@google/gemini-cli',
  packagePath: Object.freeze(['@google', 'gemini-cli']),
  runtime: 'node',
} satisfies AgentCliPackagePolicy);

export class GeminiAdapter implements AgentAdapter {
  public readonly identity = GEMINI_IDENTITY;

  public constructor(private readonly configuredExecutable = 'gemini') {}

  public async inspect(): Promise<AgentAvailability> {
    let invocation;
    try {
      invocation = await resolveAgentCliInvocation(this.configuredExecutable, GEMINI_PACKAGE);
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
        /^(?:gemini(?:-cli)?\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/iu,
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
      GEMINI_PACKAGE,
    );
    const validated = await validateAgentLaunchRequest(request, invocation);
    if (Object.keys(validated.environment).some((name) => name.toUpperCase().startsWith('CI_'))) {
      throw new AgentAdapterError('INVALID_LAUNCH_REQUEST');
    }
    return {
      arguments: [...invocation.prefixArguments],
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
