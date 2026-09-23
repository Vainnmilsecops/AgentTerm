import { useId, useMemo, useRef, useState } from 'react';
import {
  deriveTaskAttention,
  type AgentWorkspaceOverview,
  type TaskAttentionKind,
} from '@agentterm/application';

const labels: Record<TaskAttentionKind, string> = {
  SESSION_FAILED: 'Latest session failed',
  GATE_FAILED: 'Quality gate failed',
  PLAN_PENDING: 'Plan awaiting acceptance',
  REVIEW_PENDING: 'Review awaiting decision',
  DEPENDENCY_BLOCKED: 'Required dependency incomplete',
};

export function TaskAttentionCenter({
  overview,
  onOpenTask,
  onRefresh,
  error,
}: {
  readonly overview: AgentWorkspaceOverview;
  readonly onOpenTask: (taskId: string) => void | Promise<void>;
  readonly onRefresh: () => void | Promise<void>;
  readonly error?: string | undefined;
}) {
  const items = useMemo(() => deriveTaskAttention(overview), [overview]);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(true);
  const composing = useRef(false);
  const inFlight = useRef(false);
  const [operation, setOperation] = useState<'refresh' | 'open' | undefined>();
  const [localError, setLocalError] = useState<string>();
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = (restore = true) => {
    restoreFocus.current = restore;
    dialog.current?.close();
    setOpen(false);
  };
  const run = async (kind: 'refresh' | 'open', taskId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOperation(kind);
    setLocalError(undefined);
    try {
      if (kind === 'refresh') await onRefresh();
      else if (taskId !== undefined) {
        await onOpenTask(taskId);
        close(false);
      }
    } catch {
      setLocalError(
        kind === 'refresh'
          ? 'Could not refresh. Showing the last workspace snapshot; try again.'
          : 'Task could not be opened. Refresh and try again.',
      );
    } finally {
      inFlight.current = false;
      setOperation(undefined);
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="secondary-action attention-trigger"
        data-attention-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Needs attention: ${items.length} tasks`}
        onClick={() => {
          restoreFocus.current = true;
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        Needs attention <span className="attention-count">{items.length}</span>
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="attention-center"
        data-attention-dialog
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onCancel={(event) => {
          event.preventDefault();
          if (!composing.current) close();
        }}
        onClose={() => {
          setOpen(false);
          if (restoreFocus.current) trigger.current?.focus();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && !composing.current) {
            event.preventDefault();
            close();
          }
        }}
      >
        <header className="attention-center__header">
          <div>
            <p className="eyebrow">All loaded projects</p>
            <h2 id={`${id}-title`}>Needs attention</h2>
          </div>
          <button type="button" className="secondary-action" onClick={() => close()}>
            Close
          </button>
        </header>
        <p id={`${id}-description`} className="attention-center__hint">
          One entry per task, based on the last workspace snapshot. No automatic task actions. Gate
          evidence covers the latest 20 runs per task, not a complete health check.
        </p>
        <div className="attention-center__toolbar">
          <p role="status" aria-live="polite" aria-atomic="true">
            {items.length} {items.length === 1 ? 'task needs' : 'tasks need'} attention
          </p>
          <button
            type="button"
            className="secondary-action"
            aria-disabled={operation !== undefined}
            onClick={() => void run('refresh')}
          >
            {operation === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {(localError ?? error) ? (
          <p role="alert" className="inline-error">
            {localError ?? error}
          </p>
        ) : null}
        {items.length === 0 ? (
          <p className="attention-center__empty">No tasks need attention in this snapshot.</p>
        ) : (
          <ol className="attention-center__list">
            {items.map((item) => (
              <li key={item.taskId}>
                <div className="attention-center__task">
                  <div>
                    <p className="eyebrow">
                      {item.projectName} · {item.phase}
                    </p>
                    <h3>{item.title}</h3>
                  </div>
                  <button
                    type="button"
                    className="secondary-action"
                    aria-disabled={operation !== undefined}
                    aria-label={`Open task: ${item.title}`}
                    onClick={() => void run('open', item.taskId)}
                  >
                    Open task
                  </button>
                </div>
                <ul className="attention-center__reasons">
                  {item.reasons.map((reason) => {
                    const date =
                      reason.occurredAt === undefined ? undefined : new Date(reason.occurredAt);
                    const validDate = date !== undefined && Number.isFinite(date.getTime());
                    return (
                      <li key={`${reason.kind}:${reason.evidenceId}`}>
                        <span>
                          {labels[reason.kind]}
                          {reason.gateId === undefined
                            ? null
                            : ` · ${reason.gateId} (${reason.gateStatus})`}
                        </span>
                        {validDate ? (
                          <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
                        ) : (
                          <span className="attention-center__hint">Time unavailable</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </dialog>
    </>
  );
}
