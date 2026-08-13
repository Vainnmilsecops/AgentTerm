import { TaskPhase, transitionTask, type AgentSession, type Task } from '@agentterm/domain';

import { AgentSessionCoordinator } from './agent-session-coordinator';
import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import {
  AgentNotConfiguredError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  TaskExecutionRetryError,
  TaskExecutionPhaseError,
  TaskExecutionStartError,
} from './errors';
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
import { serializeTaskWorkflow } from './task-workflow-serialization';

export interface StartTaskExecutionInput {
  readonly agentId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly eventSink?: PtyRuntimeEventSink;
  readonly initialSize: PtyTerminalSize;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface RetryTaskExecutionInput {
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

export interface TaskExecutionRetryResult extends TaskExecutionStartResult {
  readonly previousSession: AgentSession;
}

export async function startTaskExecution(
  input: StartTaskExecutionInput,
  dependencies: StartTaskExecutionDependencies,
): Promise<TaskExecutionStartResult> {
  return serializeTaskWorkflow(input.taskId, () =>
    startTaskExecutionExclusive(input, dependencies),
  );
}

export async function retryTaskExecution(
  input: RetryTaskExecutionInput,
  dependencies: StartTaskExecutionDependencies,
): Promise<TaskExecutionRetryResult> {
  return serializeTaskWorkflow(input.taskId, async () => {
    assertNewSessionId(input.sessionId);
    const task = await requireExecutionTask(input.taskId, dependencies);
    validateExecutionPhase(task);
    await assertUnusedSessionId(input.sessionId, dependencies.sessionCoordinator);
    await assertNoOwnedRuntime(input, dependencies.sessionCoordinator);
    const history = await dependencies.sessionCoordinator.listByTaskId(input.taskId);
    assertNoActiveSession(history, input.taskId, input.sessionId);
    const previousSession = history.at(-1);
    if (previousSession === undefined || !isTerminalSession(previousSession)) {
      throw new TaskExecutionRetryError('NO_RETRYABLE_SESSION', input.taskId, input.sessionId);
    }
    if (!dependencies.sessionCoordinator.isAgentConfigured(previousSession.agentId)) {
      throw new TaskExecutionRetryError('AGENT_NOT_CONFIGURED', input.taskId, input.sessionId);
    }

    const execution = await executeTaskAttempt(
      { ...input, agentId: previousSession.agentId },
      dependencies,
    );
    return Object.freeze({ ...execution, previousSession });
  });
}

async function startTaskExecutionExclusive(
  input: StartTaskExecutionInput,
  dependencies: StartTaskExecutionDependencies,
): Promise<TaskExecutionStartResult> {
  assertNewSessionId(input.sessionId);
  assertConfiguredAgent(input.agentId, dependencies.sessionCoordinator);
  const initialTask = await requireExecutionTask(input.taskId, dependencies);
  validateExecutionPhase(initialTask);
  await assertUnusedSessionId(input.sessionId, dependencies.sessionCoordinator);
  await assertNoOwnedRuntime(input, dependencies.sessionCoordinator);
  const history = await dependencies.sessionCoordinator.listByTaskId(input.taskId);
  assertNoActiveSession(history, input.taskId, input.sessionId);
  if (history.length > 0) {
    throw new TaskExecutionRetryError('RETRY_REQUIRED', input.taskId, input.sessionId);
  }

  return executeTaskAttempt(input, dependencies);
}

async function assertNoOwnedRuntime(
  input: Pick<RetryTaskExecutionInput, 'sessionId' | 'taskId'>,
  coordinator: AgentSessionCoordinator,
): Promise<void> {
  const owned = await coordinator.findOwnedRuntimeByTaskId(input.taskId);
  if (owned !== undefined) {
    throw new TaskExecutionRetryError('ACTIVE_SESSION_EXISTS', input.taskId, input.sessionId, {
      activeSessionId: owned.id,
    });
  }
}

async function executeTaskAttempt(
  input: StartTaskExecutionInput,
  dependencies: StartTaskExecutionDependencies,
): Promise<TaskExecutionStartResult> {
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
    validateExecutionPhase(currentTask);
    runningTask = toRunning(currentTask);
    if (runningTask !== currentTask) {
      await dependencies.tasks.update(runningTask, currentTask.phase);
    }
  } catch (error) {
    throw new TaskExecutionStartError('TASK_STATE', input.taskId, input.sessionId, worktree, {
      cause: error,
    });
  }

  try {
    const session = await dependencies.sessionCoordinator.start({
      agentId: input.agentId,
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

function assertConfiguredAgent(agentId: string, coordinator: AgentSessionCoordinator): void {
  if (!coordinator.isAgentConfigured(agentId)) {
    throw new AgentNotConfiguredError(agentId);
  }
}

async function requireExecutionTask(
  taskId: string,
  dependencies: StartTaskExecutionDependencies,
): Promise<Task> {
  const task = await dependencies.tasks.findById(taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  return task;
}

async function assertUnusedSessionId(
  sessionId: string,
  coordinator: AgentSessionCoordinator,
): Promise<void> {
  if ((await coordinator.findById(sessionId)) !== undefined) {
    throw new EntityAlreadyExistsError('AgentSession', sessionId);
  }
}

function assertNoActiveSession(
  sessions: readonly AgentSession[],
  taskId: string,
  sessionId: string,
): void {
  const active = sessions.find(hasUnsettledTaskCodeWriter);
  if (active !== undefined) {
    throw new TaskExecutionRetryError('ACTIVE_SESSION_EXISTS', taskId, sessionId, {
      activeSessionId: active.id,
    });
  }
}

function isTerminalSession(session: AgentSession): boolean {
  return session.status === 'EXITED' || session.status === 'FAILED';
}

function assertNewSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('Agent Session id must not be blank.');
  }
}

function validateExecutionPhase(task: Task): void {
  if (!canStartTaskExecution(task)) {
    throw new TaskExecutionPhaseError(task.id, task.phase);
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
