import {
  createAgentSession,
  recordAgentSessionEvent,
  setProviderSessionId,
  type AgentSession,
  type AgentSessionHostOwnership,
} from '@agentterm/domain';

import { AgentSessionResumeUnavailableError, PtyRuntimeError } from './errors';
import type {
  AgentAvailability,
  AgentCatalog,
  AgentLaunchRequest,
  AgentSessionRepository,
  HostReattacher,
  PtyHandle,
  PtyRuntime,
  PtyRuntimeEvent,
  PtyRuntimeEventSink,
  PtyTerminalSize,
} from './ports';

export interface TryReattachAgentSessionInput {
  readonly eventSink?: PtyRuntimeEventSink;
  readonly initialSize: PtyTerminalSize;
  readonly sessionId: string;
}

export type TryReattachAgentSessionResult =
  | { readonly handle: PtyHandle; readonly kind: 'reattached'; readonly session: AgentSession }
  | {
      readonly kind: 'skipped';
      readonly reason: TryReattachSkipReason;
      readonly session: AgentSession;
    };

export type TryReattachSkipReason =
  'HOST_DEAD' | 'NO_OWNERSHIP' | 'RUNTIME_REJECTED' | 'SESSION_NOT_FOUND';

export interface AgentSessionRecoveryDependencies {
  readonly agents: AgentCatalog;
  readonly clock: () => number;
  readonly hostReattacher: HostReattacher;
  readonly runtime: PtyRuntime;
  readonly sessions: AgentSessionRepository;
}

export async function tryReattachAgentSession(
  input: TryReattachAgentSessionInput,
  dependencies: AgentSessionRecoveryDependencies,
): Promise<TryReattachAgentSessionResult> {
  const session = await dependencies.sessions.findById(input.sessionId);
  if (session === undefined) {
    return {
      kind: 'skipped',
      reason: 'SESSION_NOT_FOUND',
      session: missingSessionMarker(input.sessionId),
    };
  }

  if (session.hostOwnership === undefined) {
    return { kind: 'skipped', reason: 'NO_OWNERSHIP', session };
  }

  const inspection = await dependencies.hostReattacher.inspect(session.hostOwnership);
  if (inspection.kind === 'dead') {
    return { kind: 'skipped', reason: 'HOST_DEAD', session };
  }

  try {
    const handle = await dependencies.runtime.reattach(
      session.hostOwnership,
      input.initialSize,
      buildReattachSink(input.eventSink),
    );
    return { handle, kind: 'reattached', session };
  } catch (error) {
    if (error instanceof PtyRuntimeError) {
      return { kind: 'skipped', reason: 'RUNTIME_REJECTED', session };
    }
    throw error;
  }
}

export interface TryResumeAgentSessionInput {
  readonly eventSink: PtyRuntimeEventSink;
  readonly initialSize: PtyTerminalSize;
  readonly previousSessionId: string;
  readonly request: AgentLaunchRequest;
}

export interface TryResumeAgentSessionResult {
  readonly session: AgentSession;
}

/**
 * Restarts a provider with the persisted session id and writes a fresh Agent
 * Session row that points at the previous attempt through its history. The
 * previous attempt is left untouched so the immutable history is preserved.
 */
export async function tryResumeAgentSession(
  input: TryResumeAgentSessionInput,
  dependencies: AgentSessionRecoveryDependencies,
): Promise<TryResumeAgentSessionResult> {
  const previous = await dependencies.sessions.findById(input.previousSessionId);
  if (previous === undefined) {
    throw new AgentSessionResumeUnavailableError(
      input.previousSessionId,
      'PREVIOUS_SESSION_NOT_FOUND',
    );
  }
  if (previous.providerSessionId === undefined) {
    throw new AgentSessionResumeUnavailableError(
      input.previousSessionId,
      'PROVIDER_SESSION_ID_MISSING',
    );
  }

  const adapter = dependencies.agents.findById(previous.agentId);
  if (adapter === undefined || adapter.identity.id !== previous.agentId) {
    throw new AgentSessionResumeUnavailableError(input.previousSessionId, 'AGENT_NOT_CONFIGURED');
  }

  const availability = await adapter.inspect();
  if (!advertisesResume(availability)) {
    throw new AgentSessionResumeUnavailableError(input.previousSessionId, 'RESUME_UNSUPPORTED');
  }

  const resumeSessionId = previous.providerSessionId;
  const now = dependencies.clock();
  const newSessionId = `${previous.id}--resume-${now}`;
  const created = createAgentSession({
    agentId: previous.agentId,
    createdAt: now,
    id: newSessionId,
    taskId: previous.taskId,
  });

  await dependencies.sessions.insert(created);

  try {
    const command = await adapter.buildLaunchCommand({
      ...input.request,
      resumeSessionId,
    });
    await dependencies.runtime.open(
      {
        arguments: command.arguments,
        environment: command.environment,
        executablePath: command.executablePath,
        initialSize: input.initialSize,
        workingDirectory: command.workingDirectory,
      },
      input.eventSink,
    );
  } catch (error) {
    const terminated = recordAgentSessionEvent(created, {
      code: 'PROVIDER_RESUME_FAILED',
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: Math.max(dependencies.clock(), created.createdAt),
      stage: 'START',
    });
    try {
      await dependencies.sessions.append(terminated, created.history.length);
    } catch {
      // The resume failure is best-effort; the underlying error must still surface.
    }
    throw error;
  }

  const stored = await dependencies.sessions.findById(newSessionId);
  if (stored === undefined) {
    throw new PtyRuntimeError('spawn', 'RUNTIME_FAILURE');
  }
  return { session: setProviderSessionId(stored, resumeSessionId) };
}

function missingSessionMarker(id: string): AgentSession {
  const createdAt = 0;
  return createAgentSession({
    agentId: 'unknown',
    createdAt,
    id,
    taskId: 'unknown',
  });
}

function buildReattachSink(override?: PtyRuntimeEventSink): PtyRuntimeEventSink {
  if (override === undefined) {
    return () => undefined;
  }
  return (event: PtyRuntimeEvent) => {
    override(event);
  };
}

function advertisesResume(availability: AgentAvailability): boolean {
  return availability.kind === 'available' && availability.capabilities.includes('SESSION_RESUME');
}

export type { AgentSessionHostOwnership };
