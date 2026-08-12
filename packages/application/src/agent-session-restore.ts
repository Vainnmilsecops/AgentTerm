import { AgentSessionStatus, recordAgentSessionEvent, type AgentSession } from '@agentterm/domain';

import { AgentSessionPersistenceError } from './errors';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  ProjectCatalog,
  QualityGateRunRepository,
  TaskCatalog,
} from './ports';
import { loadAgentWorkspace, type AgentWorkspaceOverview } from './workspace-overview';

export interface RestoreAgentSessionsResult {
  readonly reconciledSessions: readonly AgentSession[];
}

const runtimeOwnershipLostCode = 'RUNTIME_OWNERSHIP_LOST';

/** Run once during process startup, before this process can own or launch any PTY runtime. */
export async function restoreAgentSessionsAfterRestart(
  sessions: AgentSessionRepository,
  clock: () => number,
): Promise<RestoreAgentSessionsResult> {
  const activeSessions = await sessions.listActive();
  const reconciledSessions: AgentSession[] = [];

  for (const current of activeSessions) {
    if (isTerminal(current)) {
      continue;
    }
    const lastEvent = current.history.at(-1);
    if (lastEvent === undefined) {
      throw new AgentSessionPersistenceError(current.id);
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
      if (latest !== undefined && isTerminal(latest)) {
        reconciledSessions.push(latest);
        continue;
      }
      throw new AgentSessionPersistenceError(current.id);
    }
  }

  return Object.freeze({ reconciledSessions: Object.freeze(reconciledSessions) });
}

export async function restoreAgentWorkspaceAfterRestart(
  projects: ProjectCatalog,
  tasks: TaskCatalog,
  sessions: AgentSessionRepository,
  artifacts: ExecutionArtifactRepository,
  qualityGateRuns: QualityGateRunRepository,
  clock: () => number,
): Promise<AgentWorkspaceOverview> {
  await restoreAgentSessionsAfterRestart(sessions, clock);
  return loadAgentWorkspace(projects, tasks, sessions, artifacts, qualityGateRuns);
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

function isTerminal(session: AgentSession): boolean {
  return (
    session.status === AgentSessionStatus.EXITED || session.status === AgentSessionStatus.FAILED
  );
}
