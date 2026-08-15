import {
  ExecutionArtifactKind,
  TaskPhase,
  createExecutionArtifact as createDomainExecutionArtifact,
  type AgentSession,
  type ExecutionArtifact,
  type Task,
} from '@agentterm/domain';

import {
  AgentNotConfiguredError,
  ArtifactProvenanceError,
  EntityAlreadyExistsError,
  EntityNotFoundError,
  TaskExecutionPhaseError,
  TaskResearchPhaseError,
} from './errors';
import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  TaskRepository,
} from './ports';
import { AgentSessionCoordinator } from './agent-session-coordinator';
import { serializeTaskWorkflow } from './task-workflow-serialization';
import { ensureTaskWorktree } from './task-worktree-use-cases';

export interface RecordResearchArtifactInput {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface RecordResearchArtifactDependencies {
  readonly artifacts: ExecutionArtifactRepository;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
}

export async function recordResearchArtifact(
  input: RecordResearchArtifactInput,
  dependencies: RecordResearchArtifactDependencies,
): Promise<ExecutionArtifact> {
  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await requireBacklogTask(input.taskId, dependencies.tasks);
    const artifact = createDomainExecutionArtifact({
      ...input,
      kind: ExecutionArtifactKind.RESEARCH,
    });
    const session = await dependencies.sessions.findById(input.sessionId);
    if (session === undefined) {
      throw new EntityNotFoundError('AgentSession', input.sessionId);
    }
    if (session.taskId !== task.id) {
      throw new ArtifactProvenanceError(artifact.id, artifact.taskId, session.id);
    }
    await dependencies.artifacts.insert(artifact, task.phase);
    return artifact;
  });
}

export interface StartTaskResearchInput {
  readonly agentId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly eventSink?: import('./ports').PtyRuntimeEventSink;
  readonly initialSize: import('./ports').PtyTerminalSize;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface StartTaskResearchDependencies {
  readonly git: import('./ports').GitTaskWorktreeLifecycle;
  readonly localProjects: import('./ports').LocalProjectLocator;
  readonly sessionCoordinator: AgentSessionCoordinator;
  readonly tasks: TaskRepository;
  readonly worktrees: import('./ports').TaskWorktreeRepository;
}

export interface TaskResearchStartResult {
  readonly session: AgentSession;
  readonly task: Task;
  readonly worktree: import('./ports').TaskWorktreeEnsureResult;
}

export async function startTaskResearch(
  input: StartTaskResearchInput,
  dependencies: StartTaskResearchDependencies,
): Promise<TaskResearchStartResult> {
  return serializeTaskWorkflow(input.taskId, async () => {
    assertNewSessionId(input.sessionId);
    assertConfiguredAgent(input.agentId, dependencies.sessionCoordinator);
    const task = await requireResearchTask(input.taskId, dependencies.tasks);
    await assertUnusedSessionId(input.sessionId, dependencies.sessionCoordinator);
    const history = await dependencies.sessionCoordinator.listByTaskId(input.taskId);
    assertNoActiveSession(history, input.taskId, input.sessionId);
    return executeResearchAttempt(input, dependencies, task);
  });
}

async function executeResearchAttempt(
  input: StartTaskResearchInput,
  dependencies: StartTaskResearchDependencies,
  task: Task,
): Promise<TaskResearchStartResult> {
  const worktree = await ensureTaskWorktree(
    { taskId: input.taskId },
    dependencies.tasks,
    dependencies.localProjects,
    dependencies.worktrees,
    dependencies.git,
  );

  try {
    const refreshed = await dependencies.tasks.findById(input.taskId);
    if (refreshed === undefined) {
      throw new EntityNotFoundError('Task', input.taskId);
    }
    assertResearchPhase(refreshed);
    const session = await dependencies.sessionCoordinator.start({
      agentId: input.agentId,
      environment: input.environment,
      ...(input.eventSink === undefined ? {} : { eventSink: input.eventSink }),
      initialInput: createResearchKickoff(refreshed),
      initialSize: input.initialSize,
      sessionId: input.sessionId,
      taskId: input.taskId,
      expectedTaskPhase: TaskPhase.BACKLOG,
      workingDirectory: worktree.worktree.worktreePath,
    });
    return Object.freeze({ session, task: refreshed, worktree });
  } catch (error) {
    if (error instanceof TaskResearchPhaseError) {
      throw error;
    }
    throw new TaskExecutionPhaseError(input.taskId, task.phase, {
      cause: error,
    });
  }
}

function createResearchKickoff(task: Task): string {
  const taskId = collapseKickoffText(task.id);
  const title = collapseKickoffText(task.title);
  const brief = ensureSentence(collapseKickoffText(task.brief ?? task.title));
  return (
    `AgentTerm Research "${title}" (${taskId}). Brief: ${brief} ` +
    `Investigate the Task and capture a # Research markdown artifact; do not move the Task into planning, do not modify code under version control, and do not mark the Task DONE.\r`
  );
}

function ensureSentence(value: string): string {
  return /[.!?]$/u.test(value) ? value : `${value}.`;
}

function collapseKickoffText(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function assertConfiguredAgent(agentId: string, coordinator: AgentSessionCoordinator): void {
  if (!coordinator.isAgentConfigured(agentId)) {
    throw new AgentNotConfiguredError(agentId);
  }
}

async function requireBacklogTask(taskId: string, tasks: TaskRepository): Promise<Task> {
  const task = await tasks.findById(taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  if (task.phase !== TaskPhase.BACKLOG) {
    throw new TaskResearchPhaseError(taskId, task.phase, 'TASK_NOT_IN_BACKLOG');
  }
  return task;
}

function assertResearchPhase(task: Task): void {
  if (task.phase !== TaskPhase.BACKLOG) {
    throw new TaskResearchPhaseError(task.id, task.phase, 'TASK_NOT_IN_BACKLOG');
  }
}

async function requireResearchTask(taskId: string, tasks: TaskRepository): Promise<Task> {
  const task = await tasks.findById(taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  assertResearchPhase(task);
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
    throw new TaskExecutionPhaseError(taskId, TaskPhase.BACKLOG, {
      activeSessionId: active.id,
      sessionId,
    });
  }
}

function assertNewSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError('Agent Session id must not be blank.');
  }
}

export interface ResearchEvidenceInput {
  readonly artifacts: ExecutionArtifactRepository;
  readonly taskId: string;
}

export async function hasValidResearchEvidence(
  input: ResearchEvidenceInput,
): Promise<boolean> {
  const latest = await input.artifacts.findLatestByTaskIdAndKind(
    input.taskId,
    ExecutionArtifactKind.RESEARCH,
  );
  return latest !== undefined && latest.validation === 'VALID';
}