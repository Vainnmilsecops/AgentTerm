import { TaskPhase, transitionTask, type AgentSession, type Task } from '@agentterm/domain';

import { AgentSessionCoordinator } from './agent-session-coordinator';
import { EntityAlreadyExistsError, EntityNotFoundError, TaskExecutionStartError } from './errors';
import type {
  GitTaskWorktreeLifecycle,
  LocalProjectLocator,
  PtyRuntimeEventSink,
  PtyTerminalSize,
  TaskRepository,
  TaskWorktreeEnsureResult,
  TaskWorktreeRepository,
} from './ports';
import { ensureTaskWorktree } from './task-worktree-use-cases';

export interface StartTaskExecutionInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly eventSink?: PtyRuntimeEventSink;
  readonly initialSize: PtyTerminalSize;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface StartTaskExecutionDependencies {
  readonly git: GitTaskWorktreeLifecycle;
  readonly localProjects: LocalProjectLocator;
  readonly sessionCoordinator: AgentSessionCoordinator;
  readonly tasks: TaskRepository;
  readonly worktrees: TaskWorktreeRepository;
}

export interface TaskExecutionStartResult {
  readonly session: AgentSession;
  readonly task: Task;
  readonly worktree: TaskWorktreeEnsureResult;
}

export async function startTaskExecution(
  input: StartTaskExecutionInput,
  dependencies: StartTaskExecutionDependencies,
): Promise<TaskExecutionStartResult> {
  assertNewSessionId(input.sessionId);
  const initialTask = await dependencies.tasks.findById(input.taskId);
  if (initialTask === undefined) {
    throw new EntityNotFoundError('Task', input.taskId);
  }
  validateExecutionPhase(initialTask);
  if ((await dependencies.sessionCoordinator.findById(input.sessionId)) !== undefined) {
    throw new EntityAlreadyExistsError('AgentSession', input.sessionId);
  }

  const worktree = await ensureTaskWorktree(
    { taskId: input.taskId },
    dependencies.tasks,
    dependencies.localProjects,
    dependencies.worktrees,
    dependencies.git,
  );

  let runningTask: Task;
  try {
    const currentTask = await dependencies.tasks.findById(input.taskId);
    if (currentTask === undefined) {
      throw new EntityNotFoundError('Task', input.taskId);
    }
    runningTask = toRunning(currentTask);
    if (runningTask !== currentTask) {
      await dependencies.tasks.update(runningTask);
    }
  } catch (error) {
    throw new TaskExecutionStartError('TASK_STATE', input.taskId, input.sessionId, worktree, {
      cause: error,
    });
  }

  try {
    const session = await dependencies.sessionCoordinator.start({
      environment: input.environment,
      ...(input.eventSink === undefined ? {} : { eventSink: input.eventSink }),
      initialSize: input.initialSize,
      sessionId: input.sessionId,
      taskId: input.taskId,
      workingDirectory: worktree.worktree.worktreePath,
    });
    return Object.freeze({ session, task: runningTask, worktree });
  } catch (error) {
    const session = await readSessionAfterFailure(dependencies.sessionCoordinator, input.sessionId);
    throw new TaskExecutionStartError('SESSION_START', input.taskId, input.sessionId, worktree, {
      cause: error,
      ...(session === undefined ? {} : { session }),
    });
  }
}

function assertNewSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('Agent Session id must not be blank.');
  }
}

function validateExecutionPhase(task: Task): void {
  if (!canStartTaskExecution(task)) {
    transitionTask(task, TaskPhase.RUNNING);
  }
}

export function canStartTaskExecution(task: Pick<Task, 'phase'>): boolean {
  return task.phase === TaskPhase.PLANNING || task.phase === TaskPhase.RUNNING;
}

function toRunning(task: Task): Task {
  return task.phase === TaskPhase.RUNNING ? task : transitionTask(task, TaskPhase.RUNNING);
}

async function readSessionAfterFailure(
  coordinator: AgentSessionCoordinator,
  sessionId: string,
): Promise<AgentSession | undefined> {
  try {
    return await coordinator.findById(sessionId);
  } catch {
    return undefined;
  }
}
