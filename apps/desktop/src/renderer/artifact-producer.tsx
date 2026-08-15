import { useMemo, useState, type ReactNode } from 'react';

import {
  ExecutionArtifactKindValue,
  type ExecutionArtifact,
  type Task,
  type WorkspaceTaskOverview,
} from '@agentterm/application';

import {
  defaultArtifactDraft,
  selectArtifactKindForPhase,
  validateArtifactDraft,
  type ArtifactDraft,
} from './artifact-producer-state';

export interface ArtifactProducerProps {
  readonly activeSessionId: string | undefined;
  readonly disabled: boolean;
  readonly onProduce: (input: {
    readonly content: string;
    readonly createdAt: number;
    readonly id: string;
    readonly kind: ExecutionArtifact['kind'];
    readonly sessionId: string | undefined;
    readonly taskId: string;
  }) => Promise<ExecutionArtifact>;
  readonly overview: WorkspaceTaskOverview;
  readonly task: Task;
}

export function ArtifactProducer({
  activeSessionId,
  disabled,
  onProduce,
  overview,
  task,
}: ArtifactProducerProps): ReactNode {
  const initialKind = selectArtifactKindForPhase(task.phase);
  const [draft, setDraft] = useState<ArtifactDraft>(() =>
    defaultArtifactDraft(task, initialKind, activeSessionId),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [lastResult, setLastResult] = useState<ExecutionArtifact | undefined>(
    overview.artifacts.at(0),
  );

  const validation = useMemo(() => validateArtifactDraft(draft), [draft]);
  const kindOptions: ReadonlyArray<ExecutionArtifact['kind']> = useMemo(
    () => [
      ExecutionArtifactKindValue.PLAN,
      ExecutionArtifactKindValue.EXECUTION_SUMMARY,
      ExecutionArtifactKindValue.REVIEW,
    ],
    [],
  );

  if (!isProducerAvailable(task.phase)) {
    return null;
  }

  const handleSubmit = async (): Promise<void> => {
    const result = validateArtifactDraft(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      const persisted = await onProduce({
        content: draft.content,
        createdAt: Date.now(),
        id: draft.id,
        kind: draft.kind,
        sessionId: draft.sessionId,
        taskId: draft.taskId,
      });
      setLastResult(persisted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Artifact could not be persisted.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      aria-label="Produce execution artifact"
      className="artifact-producer"
      data-artifact-producer
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <header className="artifact-producer__header">
        <div>
          <p className="eyebrow">Structured evidence</p>
          <h3>Produce artifact</h3>
        </div>
        {lastResult === undefined ? null : (
          <span className="artifact-producer__last-id" data-artifact-last-id>
            Last saved: {lastResult.id.slice(0, 8)}
          </span>
        )}
      </header>
      <fieldset className="artifact-producer__kind" disabled={disabled || submitting}>
        <legend className="artifact-producer__legend">Kind</legend>
        {kindOptions.map((value) => (
          <label key={value}>
            <input
              checked={draft.kind === value}
              data-artifact-kind={value}
              disabled={disabled || submitting}
              name="artifact-kind"
              onChange={() =>
                setDraft((current) => ({
                  ...current,
                  kind: value,
                  sessionId:
                    value === ExecutionArtifactKindValue.REVIEW
                      ? activeSessionId
                      : current.sessionId,
                }))
              }
              type="radio"
              value={value}
            />
            <span>{value}</span>
          </label>
        ))}
      </fieldset>
      <label className="artifact-producer__field">
        <span className="artifact-producer__legend">Markdown content</span>
        <textarea
          aria-label="Artifact content"
          data-artifact-content
          disabled={disabled || submitting}
          onChange={(event) =>
            setDraft((current) => ({ ...current, content: event.currentTarget.value }))
          }
          rows={8}
          spellCheck
          value={draft.content}
        />
      </label>
      <label className="artifact-producer__field">
        <span className="artifact-producer__legend">Session binding</span>
        <select
          aria-label="Artifact session binding"
          data-artifact-session
          disabled={disabled || submitting || activeSessionId === undefined}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              sessionId: event.currentTarget.value === '' ? undefined : event.currentTarget.value,
            }))
          }
          value={draft.sessionId ?? ''}
        >
          <option value="">Task-level (no session)</option>
          {activeSessionId === undefined ? null : (
            <option value={activeSessionId}>{activeSessionId.slice(0, 8)}</option>
          )}
        </select>
      </label>
      {error === undefined ? null : (
        <p className="artifact-producer__error" role="alert">
          {error}
        </p>
      )}
      {!validation.ok ? (
        <p className="artifact-producer__hint" data-artifact-hint>
          {validation.reason}
        </p>
      ) : null}
      <button
        className="artifact-producer__submit"
        data-artifact-submit
        disabled={disabled || submitting || !validation.ok}
        type="submit"
      >
        {submitting ? 'Saving artifact\u2026' : 'Persist artifact'}
      </button>
    </form>
  );
}

function isProducerAvailable(phase: Task['phase']): boolean {
  return phase === 'PLANNING' || phase === 'RUNNING' || phase === 'REVIEW';
}
