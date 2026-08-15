import { recordAgentSessionEvent, type AgentSession } from '@agentterm/domain';

import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import { AgentSessionPersistenceError } from './errors';
import type {
  AgentCatalog,
  AgentSessionRepository,
  HostReattacher,
  ProjectCatalog,
  PtyHandle,
  PtyRuntime,
  PtyRuntimeEventSink,
  PtyTerminalSize,
  QualityGateRunRepository,
  TaskCatalog,
  TaskDependencyRepository,
  TaskPlanningArtifactRepository,
  TaskReviewRepository,
} from './ports';
import { loadAgentWorkspace, type AgentWorkspaceOverview } from './workspace-overview';

export interface RestoreAgentSessionsResult {
  readonly reconciledSessions: readonly AgentSession[];
}

export interface RestoreAgentSessionsOptions {
  readonly hostReattacher?: HostReattacher;
  readonly reattachAttempt?: (
    sessionId: string,
    initialSize: PtyTerminalSize,
    eventSink?: PtyRuntimeEventSink,
  ) => Promise<{ readonly handle: PtyHandle } | undefined>;
  readonly resumeAttempt?: (
    sessionId: string,
    initialSize: PtyTerminalSize,
    eventSink: PtyRuntimeEventSink,
  ) => Promise<boolean>;
  readonly resumeInitialSize?: PtyTerminalSize;
  readonly runtime?: PtyRuntime;
  readonly reattachEventSink?: PtyRuntimeEventSink;
}

const runtimeOwnershipLostCode = 'RUNTIME_OWNERSHIP_LOST';

/** Run once during process startup, before this process can own or launch any PTY runtime. */
export async function restoreAgentSessionsAfterRestart(
  sessions: AgentSessionRepository,
  clock: () => number,
  options: RestoreAgentSessionsOptions = {},
): Promise<RestoreAgentSessionsResult> {
  const activeSessions = await sessions.listActive();
  const reconciledSessions: AgentSession[] = [];

  for (const current of activeSessions) {
    if (!hasUnsettledTaskCodeWriter(current)) {
      continue;
    }
    const lastEvent = current.history.at(-1);
    if (lastEvent === undefined) {
      throw new AgentSessionPersistenceError(current.id);
    }

    const recovered = await tryRecoverSession(current, options);
    if (recovered !== undefined) {
      reconciledSessions.push(recovered);
      continue;
    }

    const failed = recordAgentSessionEvent(current, {
      code: runtimeOwnershipLostCode,
      fatal: true,
      kind: 'RUNTIME_FAILED',
      occurredAt: Math.max(clock(), lastEvent.occurredAt),
      stage: 'RUNTIME',
    });

    try {
      await sessions.append(failed, current.history.length);
      reconciledSessions.push(failed);
    } catch {
      const latest = await readLatest(sessions, current.id);
      if (latest !== undefined && !hasUnsettledTaskCodeWriter(latest)) {
        reconciledSessions.push(latest);
        continue;
      }
      throw new AgentSessionPersistenceError(current.id);
    }
  }

  return Object.freeze({ reconciledSessions: Object.freeze(reconciledSessions) });
}

async function tryRecoverSession(
  current: AgentSession,
  options: RestoreAgentSessionsOptions,
): Promise<AgentSession | undefined> {
  if (
    options.reattachAttempt === undefined ||
    options.resumeAttempt === undefined ||
    options.resumeInitialSize === undefined
  ) {
    return undefined;
  }

  const recovery = await options.reattachAttempt(
    current.id,
    options.resumeInitialSize,
    options.reattachEventSink,
  );
  if (recovery === undefined) {
    return undefined;
  }

  const resumed = await options.resumeAttempt(
    current.id,
    options.resumeInitialSize,
    options.reattachEventSink ?? (() => undefined),
  );
  return resumed ? current : undefined;
}

export async function restoreAgentWorkspaceAfterRestart(
  projects: ProjectCatalog,
  tasks: TaskCatalog,
  sessions: AgentSessionRepository,
  artifacts: TaskPlanningArtifactRepository,
  qualityGateRuns: QualityGateRunRepository,
  reviews: TaskReviewRepository,
  agents: AgentCatalog,
  taskDependencies: TaskDependencyRepository,
  clock: () => number,
): Promise<AgentWorkspaceOverview> {
  await restoreAgentSessionsAfterRestart(sessions, clock);
  return loadAgentWorkspace(
    projects,
    tasks,
    sessions,
    artifacts,
    qualityGateRuns,
    reviews,
    agents,
    taskDependencies,
  );
}

async function readLatest(
  sessions: AgentSessionRepository,
  sessionId: string,
): Promise<AgentSession | undefined> {
  try {
    return await sessions.findById(sessionId);
  } catch {
    return undefined;
  }
}
