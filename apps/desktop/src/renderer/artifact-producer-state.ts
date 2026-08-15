import { ExecutionArtifactKindValue, TaskPhase, type Task } from '@agentterm/application';

type ExecutionArtifactKind = ExecutionArtifactKindValue;
type TaskPhaseValue = (typeof TaskPhase)[keyof typeof TaskPhase];

export interface ArtifactDraft {
  readonly content: string;
  readonly id: string;
  readonly kind: ExecutionArtifactKind;
  readonly sessionId: string | undefined;
  readonly taskId: string;
}

export type ArtifactValidation =
  { readonly ok: false; readonly reason: string } | { readonly ok: true };

const artifactHeadings: Readonly<Record<ExecutionArtifactKind, string>> = Object.freeze({
  [ExecutionArtifactKindValue.EXECUTION_SUMMARY]: '# Execution Summary',
  [ExecutionArtifactKindValue.PLAN]: '# Plan',
  [ExecutionArtifactKindValue.RESEARCH]: '# Research',
  [ExecutionArtifactKindValue.REVIEW]: '# Review',
});

const phaseToKind: Readonly<Record<TaskPhaseValue, ExecutionArtifactKind>> = Object.freeze({
  [TaskPhase.BACKLOG]: ExecutionArtifactKindValue.RESEARCH,
  [TaskPhase.DONE]: ExecutionArtifactKindValue.REVIEW,
  [TaskPhase.PLANNING]: ExecutionArtifactKindValue.PLAN,
  [TaskPhase.REVIEW]: ExecutionArtifactKindValue.REVIEW,
  [TaskPhase.RUNNING]: ExecutionArtifactKindValue.EXECUTION_SUMMARY,
});

const maximumArtifactBytes = 1_048_576;

export function selectArtifactKindForPhase(phase: TaskPhaseValue): ExecutionArtifactKind {
  return phaseToKind[phase];
}

export function defaultArtifactDraft(
  task: Task,
  kind: ExecutionArtifactKind,
  sessionId?: string,
): ArtifactDraft {
  return Object.freeze({
    content: `${artifactHeadings[kind]}\n\n`,
    id: `artifact-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`,
    kind,
    sessionId,
    taskId: task.id,
  });
}

export function validateArtifactDraft(draft: ArtifactDraft): ArtifactValidation {
  const heading = artifactHeadings[draft.kind];
  const normalized = draft.content.replaceAll('\r\n', '\n');
  if (draft.content.length > maximumArtifactBytes) {
    return Object.freeze({ ok: false, reason: 'Artifact content exceeds 1 MiB.' });
  }
  if (!normalized.startsWith(`${heading}\n\n`)) {
    return Object.freeze({ ok: false, reason: `Artifact must begin with ${heading}.` });
  }
  if (normalized.slice(heading.length + 2).trim() === '') {
    return Object.freeze({ ok: false, reason: 'Artifact body must not be empty.' });
  }
  return Object.freeze({ ok: true });
}

export function artifactHeadingFor(kind: ExecutionArtifactKind): string {
  return artifactHeadings[kind];
}

export function maxArtifactBytes(): number {
  return maximumArtifactBytes;
}
