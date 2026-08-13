import { TaskPhase, type AgentSession, type Task } from '@agentterm/domain';

import { AgentSessionCoordinator } from './agent-session-coordinator';
import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import { readTaskDependencyState } from './task-dependencies';
import {
  AgentNotConfiguredError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  TaskExecutionRetryError,
  TaskExecutionPhaseError,
  TaskExecutionStartError,
  TaskDependencyBlockedError,
  TaskPlanningPhaseError,
} from './errors';
import type {
  GitTaskWorktreeLifecycle,
  LocalProjectLocator,
  PtyRuntimeEventSink,
  PtyTerminalSize,
  TaskRepository,
  TaskDependencyRepository,
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
  readonly agentId: string;
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
  readonly taskDependencies: TaskDependencyRepository;
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

export interface TaskPlanningStartResult extends TaskExecutionStartResult {
  readonly previousSession: AgentSession | undefined;
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
    assertConfiguredAgent(input.agentId, dependencies.sessionCoordinator);
    const task = await requireExecutionTask(input.taskId, dependencies);
    validateExecutionPhase(task);
    await assertTaskDependenciesComplete(task.id, dependencies);
    await assertUnusedSessionId(input.sessionId, dependencies.sessionCoordinator);
    await assertNoOwnedRuntime(input, dependencies.sessionCoordinator);
    const history = await dependencies.sessionCoordinator.listByTaskId(input.taskId);
    assertNoActiveSession(history, input.taskId, input.sessionId);
    const previousSession = history.at(-1);
    if (previousSession === undefined || !isTerminalSession(previousSession)) {
      throw new TaskExecutionRetryError('NO_RETRYABLE_SESSION', input.taskId, input.sessionId);
    }
    const execution = await executeTaskAttempt(input, dependencies, TaskPhase.RUNNING);
    return Object.freeze({ ...execution, previousSession });
  });
}

export async function startTaskPlanning(
  input: StartTaskExecutionInput,
  dependencies: StartTaskExecutionDependencies,
): Promise<TaskPlanningStartResult> {
  return serializeTaskWorkflow(input.taskId, async () => {
    assertNewSessionId(input.sessionId);
    assertConfiguredAgent(input.agentId, dependencies.sessionCoordinator);
    const task = await requireExecutionTask(input.taskId, dependencies);
    validatePlanningPhase(task);
    await assertTaskDependenciesComplete(task.id, dependencies);
    await assertUnusedSessionId(input.sessionId, dependencies.sessionCoordinator);
    await assertNoOwnedRuntime(input, dependencies.sessionCoordinator);
    const history = await dependencies.sessionCoordinator.listByTaskId(input.taskId);
    assertNoActiveSession(history, input.taskId, input.sessionId);
    const previousSession = history.at(-1);
    const execution = await executeTaskAttempt(input, dependencies, TaskPhase.PLANNING);
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
  await assertTaskDependenciesComplete(initialTask.id, dependencies);
  await assertUnusedSessionId(input.sessionId, dependencies.sessionCoordinator);
  await assertNoOwnedRuntime(input, dependencies.sessionCoordinator);
  const history = await dependencies.sessionCoordinator.listByTaskId(input.taskId);
  assertNoActiveSession(history, input.taskId, input.sessionId);
  if (history.length > 0) {
    throw new TaskExecutionRetryError('RETRY_REQUIRED', input.taskId, input.sessionId);
  }

  return executeTaskAttempt(input, dependencies, TaskPhase.RUNNING);
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
  expectedPhase: typeof TaskPhase.PLANNING | typeof TaskPhase.RUNNING,
): Promise<TaskExecutionStartResult> {
  const worktree = await ensureTaskWorktree(
    { taskId: input.taskId },
    dependencies.tasks,
    dependencies.localProjects,
    dependencies.worktrees,
    dependencies.git,
  );

  let currentTask: Task;
  try {
    const storedTask = await dependencies.tasks.findById(input.taskId);
    if (storedTask === undefined) {
      throw new EntityNotFoundError('Task', input.taskId);
    }
    if (expectedPhase === TaskPhase.PLANNING) {
      validatePlanningPhase(storedTask);
    } else {
      validateExecutionPhase(storedTask);
    }
    await assertTaskDependenciesComplete(storedTask.id, dependencies);
    currentTask = storedTask;
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
      expectedTaskPhase: expectedPhase,
      workingDirectory: worktree.worktree.worktreePath,
    });
    return Object.freeze({ session, task: currentTask, worktree });
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

async function assertTaskDependenciesComplete(
  taskId: string,
  dependencies: Pick<StartTaskExecutionDependencies, 'taskDependencies' | 'tasks'>,
): Promise<void> {
  const state = await readTaskDependencyState(
    taskId,
    dependencies.tasks,
    dependencies.taskDependencies,
  );
  if (state.blocked) {
    throw new TaskDependencyBlockedError(
      taskId,
      Object.freeze(
        state.dependencies
          .filter(({ satisfied }) => !satisfied)
          .map(({ dependency }) => dependency.id),
      ),
    );
  }
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
  return task.phase === TaskPhase.RUNNING;
}

export function canStartTaskPlanning(task: Pick<Task, 'phase'>): boolean {
  return task.phase === TaskPhase.PLANNING;
}

function validatePlanningPhase(task: Task): void {
  if (!canStartTaskPlanning(task)) {
    throw new TaskPlanningPhaseError(task.id, task.phase);
  }
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
