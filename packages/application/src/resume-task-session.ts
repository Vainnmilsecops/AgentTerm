import type { AgentSession } from '@agentterm/domain';

import type { AgentSessionCoordinator } from './agent-session-coordinator';
import type {
  AgentSessionRepository,
  GitTaskWorktreeLifecycle,
  PtyRuntimeEventSink,
  PtyTerminalSize,
  TaskRepository,
  TaskWorktreeRepository,
} from './ports';

export interface ResumeTaskSessionDependencies {
  readonly coordinator: AgentSessionCoordinator;
  readonly git: GitTaskWorktreeLifecycle;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
  readonly worktrees: TaskWorktreeRepository;
}

/** Resume only a recorded conversation in its verified, still-present Task worktree. */
export async function resumeTaskSession(
  input: {
    readonly previousSessionId: string;
    readonly sessionId: string;
    readonly initialSize: PtyTerminalSize;
    readonly environment: Readonly<Record<string, string>>;
    readonly eventSink: PtyRuntimeEventSink;
  },
  dependencies: ResumeTaskSessionDependencies,
): Promise<AgentSession | undefined> {
  const previous = await dependencies.sessions.findById(input.previousSessionId);
  if (previous?.providerSessionId === undefined) return undefined;
  const task = await dependencies.tasks.findById(previous.taskId);
  const worktree = await dependencies.worktrees.findByTaskId(previous.taskId);
  if (task === undefined || worktree?.lifecycleState !== 'PRESENT') return undefined;
  if (task.phase !== 'BACKLOG' && task.phase !== 'PLANNING' && task.phase !== 'RUNNING')
    return undefined;
  const inspection = await dependencies.git.inspect({
    recordedWorktree: worktree,
    repositoryRootPath: worktree.repositoryRootPath,
    taskId: task.id,
  });
  if (inspection.kind !== 'present') return undefined;
  return dependencies.coordinator.start({
    agentId: previous.agentId,
    environment: input.environment,
    eventSink: input.eventSink,
    expectedTaskPhase: task.phase,
    initialSize: input.initialSize,
    resumeFromSessionId: previous.id,
    sessionId: input.sessionId,
    taskId: task.id,
    workingDirectory: inspection.worktree.worktreePath,
  });
}
