import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import type { ResumeTaskSessionDependencies } from './resume-task-session';

export type SessionRecoveryReason =
  | 'READY'
  | 'SESSION_NOT_FOUND'
  | 'ACTIVE_SESSION'
  | 'NEWER_ATTEMPT'
  | 'PROVIDER_ID_MISSING'
  | 'TASK_PHASE'
  | 'GATE_RUNNING'
  | 'DEPENDENCY_BLOCKED'
  | 'AGENT_UNAVAILABLE'
  | 'RESUME_UNSUPPORTED'
  | 'WORKTREE_UNAVAILABLE';
export interface SessionRecoveryReadiness {
  readonly canResume: boolean;
  readonly reason: SessionRecoveryReason;
  readonly sessionId: string;
}

export async function inspectSessionRecovery(
  sessionId: string,
  deps: ResumeTaskSessionDependencies,
): Promise<SessionRecoveryReadiness> {
  const result = (reason: SessionRecoveryReason): SessionRecoveryReadiness => ({
    canResume: reason === 'READY',
    reason,
    sessionId,
  });
  const previous = await deps.sessions.findById(sessionId);
  if (previous === undefined) return result('SESSION_NOT_FOUND');
  const history = await deps.sessions.listByTaskId(previous.taskId);
  if (history.some(hasUnsettledTaskCodeWriter)) return result('ACTIVE_SESSION');
  if (history.at(-1)?.id !== previous.id) return result('NEWER_ATTEMPT');
  if (!previous.providerSessionId) return result('PROVIDER_ID_MISSING');
  const task = await deps.tasks.findById(previous.taskId);
  if (task === undefined || !['BACKLOG', 'PLANNING', 'RUNNING'].includes(task.phase))
    return result('TASK_PHASE');
  if ((await deps.qualityGateRuns.listByTaskId(task.id)).some((run) => run.status === 'RUNNING'))
    return result('GATE_RUNNING');
  for (const edge of await deps.taskDependencies.listByTaskId(task.id)) {
    const dependency = await deps.tasks.findById(edge.dependencyTaskId);
    if (dependency?.phase !== 'DONE') return result('DEPENDENCY_BLOCKED');
  }
  const adapter = deps.agents.findById(previous.agentId);
  if (adapter === undefined) return result('AGENT_UNAVAILABLE');
  const availability = await adapter.inspect();
  if (availability.kind !== 'available') return result('AGENT_UNAVAILABLE');
  if (!availability.capabilities.includes('SESSION_RESUME')) return result('RESUME_UNSUPPORTED');
  const worktree = await deps.worktrees.findByTaskId(task.id);
  if (worktree?.lifecycleState !== 'PRESENT') return result('WORKTREE_UNAVAILABLE');
  const inspected = await deps.git.inspect({
    taskId: task.id,
    recordedWorktree: worktree,
    repositoryRootPath: worktree.repositoryRootPath,
  });
  return result(inspected.kind === 'present' ? 'READY' : 'WORKTREE_UNAVAILABLE');
}
