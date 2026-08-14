import { useMemo, useState, type ReactNode } from 'react';

import type { Task } from '@agentterm/application';

import {
  defaultDependencyDraft,
  describeDependencyAction,
  selectDependencyCandidates,
  validateDependencyDraft,
  type DependencyDraft,
} from './dependency-editor-state';

export interface DependencyEditorProps {
  readonly candidates: readonly Task[];
  readonly currentTask: Task;
  readonly dependencies: readonly {
    readonly id: string;
    readonly title: string;
    readonly phase: string;
  }[];
  readonly disabled: boolean;
  readonly onAdd: (input: { readonly dependencyTaskId: string; readonly taskId: string }) => void;
  readonly onRemove: (input: {
    readonly dependencyTaskId: string;
    readonly taskId: string;
  }) => void;
}

export function DependencyEditor({
  candidates,
  currentTask,
  dependencies,
  disabled,
  onAdd,
  onRemove,
}: DependencyEditorProps): ReactNode {
  const [draft, setDraft] = useState<DependencyDraft>(() => defaultDependencyDraft(currentTask));
  const [error, setError] = useState<string | undefined>(undefined);
  const selectableCandidates = useMemo(
    () => selectDependencyCandidates(currentTask, candidates),
    [candidates, currentTask],
  );
  const validation = useMemo(() => validateDependencyDraft(draft), [draft]);

  if (candidates.length === 0) {
    return null;
  }

  const handleAdd = (): void => {
    const result = validateDependencyDraft(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(undefined);
    onAdd({ dependencyTaskId: draft.dependencyTaskId, taskId: draft.taskId });
    setDraft(defaultDependencyDraft(currentTask));
  };

  return (
    <section
      aria-label="Edit Task dependencies"
      className="dependency-editor"
      data-dependency-editor
    >
      <header>
        <div>
          <p className="eyebrow">Readiness graph</p>
          <h3>Task dependencies</h3>
        </div>
        <span>
          {dependencies.length === 0 ? 'No required Tasks' : `${dependencies.length} required`}
        </span>
      </header>
      <ul className="dependency-editor__list" data-dependency-list>
        {dependencies.map((dependency) => (
          <li className="dependency-editor__item" data-dependency-row key={dependency.id}>
            <span>
              <strong>{dependency.title}</strong>
              <span className="dependency-editor__phase">{dependency.phase}</span>
            </span>
            <button
              className="dependency-editor__remove"
              data-dependency-remove
              disabled={disabled}
              onClick={() => onRemove({ dependencyTaskId: dependency.id, taskId: currentTask.id })}
              type="button"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {dependencies.length === 0 ? (
        <p className="dependency-editor__empty">This Task has no required upstream Tasks.</p>
      ) : null}
      <div className="dependency-editor__form">
        <label>
          <span className="eyebrow">Required Task</span>
          <select
            aria-label="Dependency candidate"
            data-dependency-select
            disabled={disabled || selectableCandidates.length === 0}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dependencyTaskId: event.currentTarget.value,
              }))
            }
            value={draft.dependencyTaskId}
          >
            <option value="">Select a Task\u2026</option>
            {selectableCandidates.map(({ task: candidate }) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="dependency-editor__add"
          data-dependency-add
          disabled={disabled || !validation.ok}
          onClick={handleAdd}
          type="button"
        >
          Require Task
        </button>
      </div>
      {error === undefined ? null : (
        <p className="dependency-editor__error" role="alert">
          {error}
        </p>
      )}
      {!validation.ok ? <p className="dependency-editor__hint">{validation.reason}</p> : null}
      <p className="dependency-editor__legend" aria-live="polite">
        {describeDependencyAction('add', { title: 'a Task' })}
      </p>
    </section>
  );
}
