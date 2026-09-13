/**
 * M8 — Merge-conflict probe + auto-resolution prompt.
 *
 * The whole slice is structured around two Application use cases:
 *
 * 1. {@link checkTaskMergeConflicts} — non-destructive `git merge-tree`
 *    probe against the persisted primary Worktree's HEAD against the
 *    project-level `suggestedBaseBranch`. Reports either `clean`,
 *    `conflicts` with a bounded file list, or a typed `unavailable`
 *    reason.
 *
 * 2. {@link sendMergeConflictResolutionTaskPrompt} — opt-in user-initiated
 *    authorization of the `/agtx:merge-conflicts<Enter>` slash command.
 *    The renderer (which already owns the PTY handle through the existing
 *    `terminal-controller`) is the actual writer; the Application use
 *    case validates that the Task is in `REVIEW` and that the active
 *    Session is idle, then returns the slash-command bytes the caller
 *    forwards. No Domain rule, no plugin hook, no PTY handoff.
 *
 * No Domain type is changed. No `AgentSessionEvent` kind is added. The
 * audit trail lives in the existing projection (`mergeConflictStatus`
 * flips to `kind: 'sent'` after the renderer reports success).
 */
import { AgentSessionStatus, TaskPhase, type Task } from '@agentterm/domain';

import { EntityNotFoundError, SendMergeConflictResolutionPromptError } from './errors';
import type {
  AgentSessionRepository,
  TaskRepository,
  TaskWorktreeRepository,
  TaskMergeConflictProbe,
  MergeConflictProbe,
  MergeConflictFile,
  MergeConflictUnavailableReason,
} from './ports';

/** Bytes the renderer forwards to the attached PTY when the user triggers the resolution prompt. */
export const MERGE_CONFLICTS_PROMPT_BYTES = '/agtx:merge-conflicts\r';

export type TaskMergeConflictAvailability =
  MergeConflictUnavailableReason | 'TASK_NOT_FOUND' | 'WORKTREE_NOT_READY' | 'GIT_PROBE_FAILED';

export type TaskMergeConflictResult =
  | {
      readonly baseRef: string;
      readonly headRef: string;
      readonly kind: 'clean';
      readonly taskId: string;
    }
  | {
      readonly baseRef: string;
      readonly conflicts: readonly MergeConflictFile[];
      readonly headRef: string;
      readonly kind: 'conflicts';
      readonly taskId: string;
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: TaskMergeConflictAvailability;
      readonly taskId: string;
    };

export interface CheckTaskMergeConflictsInput {
  readonly taskId: string;
}

export interface CheckTaskMergeConflictsDependencies {
  readonly git: TaskMergeConflictProbe;
  readonly tasks: TaskRepository;
  readonly worktrees: TaskWorktreeRepository;
}

/**
 * Probe the persisted primary Worktree's HEAD against the Worktree's
 * own persisted `baseRefName` (the ref captured at Worktree-creation
 * time — i.e. the exact base the agent branched from) using a
 * non-destructive `git merge-tree` virtual merge.
 *
 * The probe is read-only: it never mutates the Worktree, never advances
 * the HEAD, and never invokes any agent. The Worktree is verified to
 * exist in the persisted repository before the Git invocation.
 */
export async function checkTaskMergeConflicts(
  input: CheckTaskMergeConflictsInput,
  dependencies: CheckTaskMergeConflictsDependencies,
): Promise<TaskMergeConflictResult> {
  const task = await dependencies.tasks.findById(input.taskId);
  if (task === undefined) {
    return Object.freeze({
      kind: 'unavailable',
      reason: 'TASK_NOT_FOUND',
      taskId: input.taskId,
    });
  }
  const worktree = await dependencies.worktrees.findByTaskId(input.taskId);
  if (worktree === undefined) {
    return Object.freeze({
      kind: 'unavailable',
      reason: 'WORKTREE_NOT_READY',
      taskId: input.taskId,
    });
  }
  const probe = await dependencies.git.probeMergeConflicts({
    baseRef: worktree.baseRefName,
    headRef: 'HEAD',
    repositoryPath: worktree.repositoryRootPath,
    worktreePath: worktree.worktreePath,
  });
  return adaptProbeResult(probe, input.taskId);
}

function adaptProbeResult(probe: MergeConflictProbe, taskId: string): TaskMergeConflictResult {
  if (probe.kind === 'clean') {
    return Object.freeze({
      baseRef: probe.baseRef,
      headRef: probe.headRef,
      kind: 'clean' as const,
      taskId,
    });
  }
  if (probe.kind === 'conflicts') {
    return Object.freeze({
      baseRef: probe.baseRef,
      conflicts: Object.freeze([...probe.files]),
      headRef: probe.headRef,
      kind: 'conflicts' as const,
      taskId,
    });
  }
  return Object.freeze({
    kind: 'unavailable' as const,
    reason:
      probe.reason === 'NO_BASE_REF' ||
      probe.reason === 'NOT_HEAD_ATTACHED' ||
      probe.reason === 'GIT_INSPECTION_FAILED'
        ? probe.reason
        : 'GIT_PROBE_FAILED',
    taskId,
  });
}

export type SendMergeConflictResolutionFailure =
  'SESSION_NOT_IDLE' | 'TASK_NOT_IN_REVIEW' | 'TASK_NOT_FOUND';

export interface SendMergeConflictResolutionInput {
  readonly sessionId: string;
  readonly taskId: string;
}

export interface SendMergeConflictResolutionDependencies {
  readonly sessions: AgentSessionRepository;
  readonly tasks: TaskRepository;
}

export interface SendMergeConflictResolutionResult {
  readonly bytes: string;
  readonly sessionId: string;
  readonly taskId: string;
}

/**
 * Validate that the Task is in `REVIEW` and the active Session is
 * `IDLE` or `WAITING_INPUT`, then return the slash-command bytes the
 * caller (renderer) forwards to the attached PTY. The renderer owns
 * the actual PTY write path; this use case never attaches or writes.
 *
 * Refuses with a typed failure when:
 * - the Task no longer exists;
 * - the Task is no longer in `REVIEW`;
 * - the latest persisted Agent Session for the Task is not idle.
 *
 * The byte string is the *only* persistent artifact the slice produces;
 * the renderer's `WorkspaceController` records success by flipping the
 * `mergeConflictStatus` projection field to `kind: 'sent'`.
 */
export async function sendMergeConflictResolutionTaskPrompt(
  input: SendMergeConflictResolutionInput,
  dependencies: SendMergeConflictResolutionDependencies,
): Promise<SendMergeConflictResolutionResult> {
  const task = await dependencies.tasks.findById(input.taskId);
  if (task === undefined) {
    throw new EntityNotFoundError('Task', input.taskId);
  }
  assertTaskInReview(task);
  const history = await dependencies.sessions.listByTaskId(task.id);
  const active = history[history.length - 1];
  if (active === undefined || active.id !== input.sessionId) {
    throw new SendMergeConflictResolutionPromptError('SESSION_NOT_IDLE', task.id);
  }
  if (
    active.status !== AgentSessionStatus.IDLE &&
    active.status !== AgentSessionStatus.WAITING_INPUT
  ) {
    throw new SendMergeConflictResolutionPromptError('SESSION_NOT_IDLE', task.id);
  }
  return Object.freeze({
    bytes: MERGE_CONFLICTS_PROMPT_BYTES,
    sessionId: active.id,
    taskId: task.id,
  });
}

function assertTaskInReview(task: Task): void {
  if (task.phase !== TaskPhase.REVIEW) {
    throw new SendMergeConflictResolutionPromptError('TASK_NOT_IN_REVIEW', task.id);
  }
}

export type { MergeConflictFile, MergeConflictProbe, MergeConflictUnavailableReason };
