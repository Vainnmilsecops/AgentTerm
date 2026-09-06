import {
  ExecutionArtifactKind,
  InvalidTaskPhaseTransitionError,
  TaskPhase,
  TaskTransitionTrigger,
  type ExecutionArtifact,
} from '@agentterm/domain';

import { canEnterPlanning } from './can-enter-planning';
import {
  EntityNotFoundError,
  TaskPlanningFlowRequiredError,
  TaskResearchPhaseError,
} from './errors';
import type {
  ApplicationSettingsRepository,
  ExecutionArtifactRepository,
  TaskRepository,
  TaskTransitionLog,
} from './ports';
import { transitionTask } from './task-use-cases';

export interface AutoAdvanceBacklogTaskInput {
  /**
   * The artifact that was just persisted by `recordResearchArtifact`. The
   * orchestrator trusts it is the latest VALID RESEARCH artifact for the
   * Task, but re-runs `canEnterPlanning` defensively.
   */
  readonly artifact: ExecutionArtifact;
}

export interface AutoAdvanceBacklogTaskDependencies {
  readonly artifacts: ExecutionArtifactRepository;
  readonly settings: ApplicationSettingsRepository;
  readonly tasks: TaskRepository;
  /** Optional; when supplied, the orchestrator writes an audit row alongside the transition. */
  readonly transitions?: TaskTransitionLog;
}

/**
 * No-op reasons, returned to the caller for telemetry. The orchestrator never
 * raises; every defensive check funnels into a tagged return value.
 */
export type AutoAdvanceBacklogTaskSkipReason =
  | 'ARTIFACT_INVALID'
  | 'CONCURRENT_TRANSITION'
  | 'DISABLED'
  | 'PHASE_NOT_BACKLOG'
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_READY';

export type AutoAdvanceBacklogTaskResult =
  | { readonly reason: AutoAdvanceBacklogTaskSkipReason; readonly transitioned: false }
  | { readonly taskId: string; readonly transitioned: true };

/**
 * Minimal research orchestrator: advances a `BACKLOG` Task to `PLANNING`
 * immediately after a VALID `research/research.md` artifact is persisted,
 * but only when the operator has opted in via the
 * `ApplicationSettings.researchAutoAdvance` flag (default off).
 *
 * The orchestrator:
 * - never raises; every defensive check produces a tagged return value
 * - serializes through `serializeTaskWorkflow` (called inside
 *   `transitionTask`) so a concurrent "Begin planning" click cannot
 *   double-fire
 * - delegates the actual transition to the existing Application
 *   `transitionTask` use case so Domain validation and the
 *   `canEnterPlanning` gate are reused
 * - re-runs `canEnterPlanning` as belt-and-braces even though the caller
 *   has just persisted the artifact
 *
 * Out of scope: multi-phase advance, retry orchestration, rollback,
 * notifications, LLM-driven phase decisions.
 */
export async function autoAdvanceBacklogTaskAfterResearch(
  input: AutoAdvanceBacklogTaskInput,
  dependencies: AutoAdvanceBacklogTaskDependencies,
): Promise<AutoAdvanceBacklogTaskResult> {
  // Defensive: re-check the artifact shape even though the caller just
  // persisted it. Keeps the orchestrator safe against future caller drift.
  if (
    input.artifact.kind !== ExecutionArtifactKind.RESEARCH ||
    input.artifact.validation !== 'VALID'
  ) {
    return Object.freeze({ reason: 'ARTIFACT_INVALID', transitioned: false });
  }

  const settings = await dependencies.settings.get();
  if (settings.researchAutoAdvance !== true) {
    return Object.freeze({ reason: 'DISABLED', transitioned: false });
  }

  const task = await dependencies.tasks.findById(input.artifact.taskId);
  if (task === undefined) {
    return Object.freeze({ reason: 'TASK_NOT_FOUND', transitioned: false });
  }

  if (task.phase !== TaskPhase.BACKLOG) {
    return Object.freeze({ reason: 'PHASE_NOT_BACKLOG', transitioned: false });
  }

  const readiness = await canEnterPlanning({
    artifacts: dependencies.artifacts,
    taskId: task.id,
    taskPhase: task.phase,
  });
  if (readiness.failure !== undefined) {
    return Object.freeze({ reason: 'TASK_NOT_READY', transitioned: false });
  }

  try {
    await transitionTask(
      {
        artifactId: input.artifact.id,
        taskId: task.id,
        to: TaskPhase.PLANNING,
        trigger: TaskTransitionTrigger.RESEARCH_AUTO_ADVANCE,
      },
      dependencies.tasks,
      dependencies.artifacts,
      dependencies.transitions,
    );
  } catch (error) {
    if (
      error instanceof InvalidTaskPhaseTransitionError ||
      error instanceof TaskPlanningFlowRequiredError ||
      error instanceof TaskResearchPhaseError ||
      error instanceof EntityNotFoundError
    ) {
      return Object.freeze({ reason: 'CONCURRENT_TRANSITION', transitioned: false });
    }
    throw error;
  }

  return Object.freeze({ taskId: task.id, transitioned: true });
}
