import { useMemo, useState, type ReactNode } from 'react';

import type { QualityGate } from '@agentterm/application';

import {
  defaultQualityGateDraft,
  describeQualityGate,
  parseQualityGateArguments,
  qualityGateKindOptions,
  qualityGateMaxTimeout,
  qualityGateMinTimeout,
  validateQualityGateDraft,
  type QualityGateDraft,
} from './quality-gate-config-state';

export interface QualityGateConfigurationProps {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly gates: readonly QualityGate[];
  readonly onRegister: (input: {
    readonly arguments: readonly string[];
    readonly executablePath: string;
    readonly id: string;
    readonly kind: QualityGate['kind'];
    readonly timeoutMs: number;
  }) => Promise<QualityGate>;
  readonly onUnregister: (gateId: string) => Promise<boolean>;
}

export function QualityGateConfiguration({
  busy,
  error,
  gates,
  onRegister,
  onUnregister,
}: QualityGateConfigurationProps): ReactNode {
  const [draft, setDraft] = useState<QualityGateDraft>(() => defaultQualityGateDraft());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);

  const validation = useMemo(() => validateQualityGateDraft(draft), [draft]);
  const arguments_ = useMemo(() => parseQualityGateArguments(draft.arguments), [draft.arguments]);

  const handleRegister = async (): Promise<void> => {
    const result = validateQualityGateDraft(draft);
    if (!result.ok) {
      setSubmitError(result.reason);
      return;
    }
    setSubmitError(undefined);
    setSubmitting(true);
    try {
      await onRegister({
        arguments: arguments_,
        executablePath: draft.executablePath,
        id: draft.id,
        kind: draft.kind,
        timeoutMs: draft.timeoutMs,
      });
      setDraft(defaultQualityGateDraft());
    } catch (cause) {
      setSubmitError(
        cause instanceof Error ? cause.message : 'Quality Gate could not be registered.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (gateId: string): Promise<void> => {
    try {
      await onUnregister(gateId);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : 'Quality Gate could not be removed.');
    }
  };

  return (
    <details className="quality-gate-config" data-quality-gate-config>
      <summary>Quality Gates</summary>
      <section className="quality-gate-config__body">
        <header>
          <p className="eyebrow">Trusted runners</p>
          <h3>Quality Gate registry</h3>
          <p>
            Define executable commands that the workspace can run against Task branches. Quality
            Gates persist to <code>quality-gates.json</code> in the AgentTerm data directory.
          </p>
        </header>
        <ul className="quality-gate-config__list" data-quality-gate-list>
          {gates.length === 0 ? (
            <li className="quality-gate-config__empty">No Quality Gates configured yet.</li>
          ) : (
            gates.map((gate) => (
              <li className="quality-gate-config__item" data-quality-gate-row key={gate.id}>
                <span>
                  <strong>{gate.id}</strong>
                  <span className="quality-gate-config__kind">{gate.kind}</span>
                </span>
                <span className="quality-gate-config__descriptor">{describeQualityGate(gate)}</span>
                <button
                  className="quality-gate-config__remove"
                  data-quality-gate-remove
                  disabled={busy || submitting}
                  onClick={() => void handleRemove(gate.id)}
                  type="button"
                >
                  Remove
                </button>
              </li>
            ))
          )}
        </ul>
        <form
          className="quality-gate-config__form"
          data-quality-gate-form
          onSubmit={(event) => {
            event.preventDefault();
            void handleRegister();
          }}
        >
          <fieldset className="quality-gate-config__grid" disabled={busy || submitting}>
            <label>
              <span className="eyebrow">Id</span>
              <input
                aria-label="Quality Gate id"
                data-quality-gate-id
                onChange={(event) =>
                  setDraft((current) => ({ ...current, id: event.currentTarget.value }))
                }
                placeholder="frontend-lint"
                spellCheck={false}
                type="text"
                value={draft.id}
              />
            </label>
            <label>
              <span className="eyebrow">Kind</span>
              <select
                aria-label="Quality Gate kind"
                data-quality-gate-kind
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    kind: event.currentTarget.value as QualityGateDraft['kind'],
                  }))
                }
                value={draft.kind}
              >
                {qualityGateKindOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="eyebrow">Executable path</span>
              <input
                aria-label="Quality Gate executable path"
                data-quality-gate-executable
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    executablePath: event.currentTarget.value,
                  }))
                }
                placeholder="C:\\Program Files\\nodejs\\node.exe"
                spellCheck={false}
                type="text"
                value={draft.executablePath}
              />
            </label>
            <label>
              <span className="eyebrow">Timeout (ms)</span>
              <input
                aria-label="Quality Gate timeout"
                data-quality-gate-timeout
                max={qualityGateMaxTimeout()}
                min={qualityGateMinTimeout()}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    timeoutMs: Number.isFinite(event.currentTarget.valueAsNumber)
                      ? event.currentTarget.valueAsNumber
                      : 0,
                  }))
                }
                type="number"
                value={draft.timeoutMs}
              />
            </label>
            <label className="quality-gate-config__arguments">
              <span className="eyebrow">Arguments (one per line)</span>
              <textarea
                aria-label="Quality Gate arguments"
                data-quality-gate-arguments
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    arguments: event.currentTarget.value,
                  }))
                }
                placeholder="--max-warnings 0\nsrc"
                rows={4}
                spellCheck={false}
                value={draft.arguments}
              />
            </label>
          </fieldset>
          {!validation.ok ? (
            <p className="quality-gate-config__hint" data-quality-gate-hint>
              {validation.reason}
            </p>
          ) : null}
          {submitError === undefined ? null : (
            <p className="quality-gate-config__error" role="alert">
              {submitError}
            </p>
          )}
          {error === undefined ? null : (
            <p className="quality-gate-config__error" role="alert">
              {error}
            </p>
          )}
          <button
            className="quality-gate-config__submit"
            data-quality-gate-submit
            disabled={busy || submitting || !validation.ok}
            type="submit"
          >
            {submitting ? 'Registering…' : 'Register Quality Gate'}
          </button>
        </form>
      </section>
    </details>
  );
}
