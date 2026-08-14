import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ContextCardProps {
  readonly children: ReactNode;
  readonly trigger: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly metadata?: readonly { readonly label: string; readonly value: string }[];
  readonly primaryAction?: { readonly label: string; readonly onClick: () => void };
}

const ENTRY_DELAY_MS = 150;

export function ContextCard({
  children,
  trigger,
  title,
  description,
  metadata,
  primaryAction,
}: ContextCardProps): ReactNode {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const containerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const scheduleOpen = (): void => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setOpen(true);
    }, ENTRY_DELAY_MS);
  };

  const cancelOpen = (): void => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setOpen(false);
  };

  return (
    <span
      className={`context-card${open ? ' context-card--open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          cancelOpen();
        }
      }}
      onFocus={scheduleOpen}
      onMouseEnter={scheduleOpen}
      onMouseLeave={cancelOpen}
      ref={containerRef}
    >
      {trigger}
      {open ? (
        <span className="context-card__panel" role="dialog" aria-label={title}>
          <strong>{title}</strong>
          <p>{description}</p>
          {metadata === undefined || metadata.length === 0 ? null : (
            <dl className="context-card__meta">
              {metadata.map((row) => (
                <span key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </span>
              ))}
            </dl>
          )}
          {primaryAction === undefined ? null : (
            <button className="context-card__action" onClick={primaryAction.onClick} type="button">
              {primaryAction.label}
            </button>
          )}
          {children}
        </span>
      ) : null}
    </span>
  );
}
