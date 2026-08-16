import { ExecutionArtifactKind, TaskPhase } from '@agentterm/domain';

import { TaskResearchPhaseError } from './errors';
import type { ExecutionArtifactRepository } from './ports';

export interface CanEnterPlanningInput {
  readonly artifacts: ExecutionArtifactRepository;
  readonly taskId: string;
  readonly taskPhase: TaskPhase;
}

export type CanEnterPlanningFailure =
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_MISSING'
  | 'TASK_NOT_IN_BACKLOG';

export interface CanEnterPlanningResult {
  readonly failure: CanEnterPlanningFailure | undefined;
  readonly taskId: string;
}

export async function canEnterPlanning(
  input: CanEnterPlanningInput,
): Promise<CanEnterPlanningResult> {
  if (input.taskPhase !== TaskPhase.BACKLOG) {
    return Object.freeze({
      failure: 'TASK_NOT_IN_BACKLOG' as CanEnterPlanningFailure,
      taskId: input.taskId,
    });
  }
  const latest = await input.artifacts.findLatestByTaskIdAndKind(
    input.taskId,
    ExecutionArtifactKind.RESEARCH,
  );
  if (latest === undefined) {
    return Object.freeze({
      failure: 'ARTIFACT_MISSING' as CanEnterPlanningFailure,
      taskId: input.taskId,
    });
  }
  if (latest.validation !== 'VALID') {
    return Object.freeze({
      failure: 'ARTIFACT_INVALID' as CanEnterPlanningFailure,
      taskId: input.taskId,
    });
  }
  return Object.freeze({ failure: undefined, taskId: input.taskId });
}

export async function assertCanEnterPlanning(
  input: CanEnterPlanningInput,
): Promise<void> {
  const result = await canEnterPlanning(input);
  if (result.failure !== undefined) {
    throw new TaskResearchPhaseError(input.taskId, input.taskPhase, result.failure);
  }
}