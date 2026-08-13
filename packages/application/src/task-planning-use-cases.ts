import {
  ExecutionArtifactKind,
  TaskPhase,
  createExecutionArtifact as createDomainExecutionArtifact,
  transitionTask,
  type ExecutionArtifact,
  type Task,
} from '@agentterm/domain';

import {
  ArtifactProvenanceError,
  EntityNotFoundError,
  TaskPlanningPhaseError,
  TaskPlanReadinessError,
} from './errors';
import { hasUnsettledTaskCodeWriter } from './agent-session-writer-state';
import type {
  AgentSessionRepository,
  ExecutionArtifactRepository,
  TaskPlanningArtifactRepository,
  TaskPlanningRepository,
  TaskRepository,
} from './ports';
import { serializeTaskWorkflow } from './task-workflow-serialization';

export interface CreateTaskPlanInput {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface TaskPlanningDependencies {
  readonly artifacts: TaskPlanningArtifactRepository;
  readonly planning: TaskPlanningRepository;
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
}

export async function createTaskPlan(
  input: CreateTaskPlanInput,
  dependencies: {
    readonly artifacts: ExecutionArtifactRepository;
    readonly sessions: AgentSessionRepository;
    readonly tasks: TaskRepository;
  },
): Promise<ExecutionArtifact> {
  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await requirePlanningTask(input.taskId, dependencies.tasks);
    const artifact = createDomainExecutionArtifact({
      ...input,
      kind: ExecutionArtifactKind.PLAN,
    });
    const session = await dependencies.sessions.findById(input.sessionId);
    if (session === undefined) {
      throw new EntityNotFoundError('AgentSession', input.sessionId);
    }
    if (session.taskId !== task.id) {
      throw new ArtifactProvenanceError(artifact.id, artifact.taskId, session.id);
    }
    await dependencies.artifacts.insert(artifact, TaskPhase.PLANNING);
    return artifact;
  });
}

export async function acceptTaskPlan(
  input: { readonly planId: string; readonly taskId: string },
  dependencies: TaskPlanningDependencies,
): Promise<Task> {
  return serializeTaskWorkflow(input.taskId, async () => {
    const task = await requirePlanningTask(input.taskId, dependencies.tasks);
    const sessions = await dependencies.sessions.listByTaskId(input.taskId);
    if (sessions.some(hasUnsettledTaskCodeWriter)) {
      throw new TaskPlanReadinessError('ACTIVE_SESSION', input.taskId, input.planId);
    }
    const plan = await dependencies.artifacts.findById(input.planId);
    if (
      plan === undefined ||
      plan.taskId !== input.taskId ||
      plan.kind !== ExecutionArtifactKind.PLAN
    ) {
      throw new TaskPlanReadinessError('PLAN_NOT_FOUND', input.taskId, input.planId);
    }
    const latestPlan = await dependencies.artifacts.findLatestByTaskIdAndKind(
      input.taskId,
      ExecutionArtifactKind.PLAN,
    );
    if (latestPlan?.id !== plan.id) {
      throw new TaskPlanReadinessError('PLAN_NOT_LATEST', input.taskId, input.planId);
    }
    if (
      plan.sessionId === undefined ||
      !sessions.some((session) => session.id === plan.sessionId && session.taskId === plan.taskId)
    ) {
      throw new TaskPlanReadinessError('PLAN_PROVENANCE_INVALID', input.taskId, input.planId);
    }
    const nextTask = transitionTask(task, TaskPhase.RUNNING);
    await dependencies.planning.acceptPlan(
      plan,
      nextTask,
      sessions.map((session) => ({ historySequence: session.history.length, id: session.id })),
    );
    return nextTask;
  });
}

async function requirePlanningTask(taskId: string, tasks: TaskRepository): Promise<Task> {
  const task = await tasks.findById(taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', taskId);
  }
  if (task.phase !== TaskPhase.PLANNING) {
    throw new TaskPlanningPhaseError(taskId, task.phase);
  }
  return task;
}
