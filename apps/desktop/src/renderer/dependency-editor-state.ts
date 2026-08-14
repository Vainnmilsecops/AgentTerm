import type { Task } from '@agentterm/application';

const stableIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

export interface DependencyDraft {
  readonly dependencyTaskId: string;
  readonly taskId: string;
}

export type DependencyValidation =
  { readonly ok: false; readonly reason: string } | { readonly ok: true };

export function defaultDependencyDraft(task: Task): DependencyDraft {
  return Object.freeze({
    dependencyTaskId: '',
    taskId: task.id,
  });
}

export interface DependencyCandidate {
  readonly task: Task;
}

export function selectDependencyCandidates(
  current: Task,
  tasks: readonly Task[],
): readonly DependencyCandidate[] {
  return Object.freeze(
    tasks
      .filter(
        (candidate) => candidate.id !== current.id && candidate.projectId === current.projectId,
      )
      .map((candidate) => Object.freeze({ task: candidate })),
  );
}

export function validateDependencyDraft(draft: DependencyDraft): DependencyValidation {
  if (draft.dependencyTaskId === '') {
    return Object.freeze({ ok: false, reason: 'Select a Task to depend on.' });
  }
  if (draft.dependencyTaskId === draft.taskId) {
    return Object.freeze({ ok: false, reason: 'A Task cannot depend on itself.' });
  }
  if (!stableIdPattern.test(draft.dependencyTaskId)) {
    return Object.freeze({ ok: false, reason: 'Task identity is invalid.' });
  }
  return Object.freeze({ ok: true });
}

export function describeDependencyAction(
  action: 'add' | 'remove',
  dependency: { readonly title: string },
): string {
  return `${action === 'add' ? 'Required by' : 'No longer required by'} ${dependency.title}`;
}
