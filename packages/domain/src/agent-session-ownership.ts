/**
 * Domain ownership record for a running Agent Session host process.
 *
 * Persisted only while the underlying ConPTY host is alive so that the application
 * can reattach to the live streams across an Electron main restart without respawning
 * the provider. The record intentionally carries only Win32 kernel identifiers:
 *   - hostPid: process identifier of the host child process
 *   - conptyInPipeName / conptyOutPipeName: Win32 named pipe names that the host
 *     exposes its input/output streams through
 *   - startedAt: timestamp the host was launched
 *
 * It never carries command argv, environment, working directory, or any provider
 * detail. Providers are resumed through a separate opaque provider session id
 * (`AgentSession.providerSessionId`) handled by the adapter layer.
 */
export interface AgentSessionHostOwnership {
  readonly conptyInPipeName: string;
  readonly conptyOutPipeName: string;
  readonly hostPid: number;
  readonly startedAt: number;
}

export interface CreateAgentSessionHostOwnershipInput {
  readonly conptyInPipeName: string;
  readonly conptyOutPipeName: string;
  readonly hostPid: number;
  readonly startedAt: number;
}

export class InvalidAgentSessionHostOwnershipError extends Error {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAgentSessionHostOwnershipError';
    this.field = field;
  }
}

const PIPE_NAME_PATTERN = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,200}$/u;

export function createAgentSessionHostOwnership(
  input: CreateAgentSessionHostOwnershipInput,
): AgentSessionHostOwnership {
  assertPipeName(input.conptyInPipeName, 'conptyInPipeName');
  assertPipeName(input.conptyOutPipeName, 'conptyOutPipeName');
  assertSafeInteger(input.hostPid, 'hostPid');
  if (input.hostPid <= 0) {
    throw new InvalidAgentSessionHostOwnershipError(
      'hostPid',
      'Agent Session host pid must be a positive integer.',
    );
  }
  assertSafeInteger(input.startedAt, 'startedAt');
  if (input.startedAt < 0) {
    throw new InvalidAgentSessionHostOwnershipError(
      'startedAt',
      'Agent Session host startedAt must not be negative.',
    );
  }

  return Object.freeze({
    conptyInPipeName: input.conptyInPipeName,
    conptyOutPipeName: input.conptyOutPipeName,
    hostPid: input.hostPid,
    startedAt: input.startedAt,
  });
}

export function isAgentSessionHostOwnership(value: unknown): value is AgentSessionHostOwnership {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.conptyInPipeName === 'string' &&
    typeof candidate.conptyOutPipeName === 'string' &&
    typeof candidate.hostPid === 'number' &&
    typeof candidate.startedAt === 'number'
  );
}

const PROVIDER_SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{4,128}$/u;

export function isValidProviderSessionId(value: string): boolean {
  return PROVIDER_SESSION_ID_PATTERN.test(value);
}

function assertPipeName(value: string, field: string): void {
  if (typeof value !== 'string' || !PIPE_NAME_PATTERN.test(value)) {
    throw new InvalidAgentSessionHostOwnershipError(
      field,
      `Agent Session host ${field} must be a valid Win32 named pipe path.`,
    );
  }
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidAgentSessionHostOwnershipError(
      field,
      `Agent Session host ${field} must be a safe integer.`,
    );
  }
}
