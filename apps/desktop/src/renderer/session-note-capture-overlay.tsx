import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

import type {
  ExecutionArtifact,
  ExecutionArtifactKindValue,
} from '@agentterm/application';
import { ExecutionArtifactKindValue as ExecutionArtifactKind } from '@agentterm/application';

export type SessionNoteKind = Extract<
  ExecutionArtifactKindValue,
  'brainstorm' | 'sweep'
>;

export interface SessionNoteCaptureOverlayProps {
  /** A small ref or anchor to return focus to on close. Optional. */
  readonly anchorRef?: { readonly current: HTMLElement | null };
  readonly busy: boolean;
  readonly errorMessage: string | undefined;
  readonly kind: SessionNoteKind;
  readonly onCancel: () => void;
  readonly onSubmit: (input: { readonly content: string }) => void;
}

const HEADING_BY_KIND: Readonly<Record<SessionNoteKind, string>> = Object.freeze({
  brainstorm: '# Brainstorm',
  sweep: '# Sweep',
});

const MAX_NOTE_BYTES = 1_048_576;

const PLACEHOLDER_BY_KIND: Readonly<Record<SessionNoteKind, string>> = Object.freeze({
  brainstorm:
    'Brainstorm: jot the rough idea, the constraint, and the question before the agent replies.',
  sweep:
    'Sweep: capture the final takeaways, the open risks, and the next concrete step before the session exits.',
});

function validate(
  content: string,
  heading: string,
): { readonly ok: false; readonly reason: string } | { readonly ok: true } {
  if (content.includes('\u0000')) {
    return { ok: false, reason: 'Note contains a NUL byte.' };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_NOTE_BYTES) {
    return { ok: false, reason: `Note exceeds the ${MAX_NOTE_BYTES} byte limit.` };
  }
  const normalized = content.replaceAll('\r\n', '\n');
  if (!normalized.startsWith(`${heading}\n\n`)) {
    return { ok: false, reason: `Note must start with the ${heading} heading followed by a blank line.` };
  }
  if (normalized.slice(heading.length + 2).trim().length === 0) {
    return { ok: false, reason: 'Note body must not be empty.' };
  }
  return { ok: true };
}

export function SessionNoteCaptureOverlay(
  props: SessionNoteCaptureOverlayProps,
): ReactElement {
  const heading = HEADING_BY_KIND[props.kind];
  const placeholder = PLACEHOLDER_BY_KIND[props.kind];
  const [body, setBody] = useState<string>('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setBody('');
    textareaRef.current?.focus();
  }, [props.kind]);

  // Escape returns focus to the anchor when the overlay unmounts or cancels.
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
      }
    }
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [props]);

  const fullContent = useMemo(() => `${heading}\n\n${body}`, [body, heading]);
  const validation = useMemo(() => validate(fullContent, heading), [fullContent, heading]);

  function handleSubmitClick(): void {
    if (validation.ok && !props.busy) {
      props.onSubmit({ content: fullContent });
    }
  }

  function handleTextareaKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      props.onCancel();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      handleSubmitClick();
    }
  }

  function handleOverlayClick(event: React.MouseEvent<HTMLDivElement>): void {
    // Click on the backdrop (not on the dialog itself) cancels.
    if (event.target === event.currentTarget) {
      props.onCancel();
    }
  }

  return (
    <div
      aria-label={`Capture ${props.kind} note`}
      aria-modal="true"
      className="session-note-capture__backdrop"
      data-testid={`session-note-capture-${props.kind}-backdrop`}
      onClick={handleOverlayClick}
      role="presentation"
    >
      <div
        aria-label={`${props.kind} note dialog`}
        className="session-note-capture__dialog"
        data-testid={`session-note-capture-${props.kind}`}
        ref={dialogRef}
        role="dialog"
      >
        <header className="session-note-capture__header">
          <h2>{`Capture ${props.kind} note`}</h2>
          <button
            aria-label="Cancel"
            className="session-note-capture__cancel"
            data-testid={`session-note-capture-${props.kind}-cancel`}
            disabled={props.busy}
            onClick={props.onCancel}
            type="button"
          >
            Cancel
          </button>
        </header>
        <p className="session-note-capture__help">
          Multi-line note. Submit with <kbd>Ctrl+Enter</kbd>. Cancel with <kbd>Esc</kbd>. The note is
          saved as a <code>{heading}</code> artifact bound to the active Agent Session.
        </p>
        <textarea
          aria-label={`${props.kind} note body`}
          className="session-note-capture__textarea"
          data-testid={`session-note-capture-${props.kind}-textarea`}
          disabled={props.busy}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={handleTextareaKeyDown}
          placeholder={placeholder}
          ref={textareaRef}
          rows={10}
          value={body}
        />
        <pre
          aria-label={`${props.kind} note preview`}
          className="session-note-capture__preview"
          data-testid={`session-note-capture-${props.kind}-preview`}
        >
          {fullContent}
        </pre>
        {!validation.ok ? (
          <p
            className="session-note-capture__error"
            data-testid={`session-note-capture-${props.kind}-validation-error`}
            role="alert"
          >
            {validation.reason}
          </p>
        ) : null}
        {props.errorMessage !== undefined ? (
          <p
            className="session-note-capture__error"
            data-testid={`session-note-capture-${props.kind}-server-error`}
            role="alert"
          >
            {props.errorMessage}
          </p>
        ) : null}
        <footer className="session-note-capture__footer">
          <button
            className="session-note-capture__submit"
            data-testid={`session-note-capture-${props.kind}-submit`}
            disabled={!validation.ok || props.busy}
            onClick={handleSubmitClick}
            type="button"
          >
            {props.busy ? 'Saving note…' : 'Save note'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Pure helper for tests: a square-record wrapper that exposes the captured
 * artifact through the existing IPC contract. Tests can import this without
 * pulling React or the renderer runtime.
 */
export function packageArtifact(
  kind: SessionNoteKind,
  artifact: ExecutionArtifact,
): { readonly kind: ExecutionArtifactKindValue; readonly artifact: ExecutionArtifact } {
  return { kind: kind === 'brainstorm' ? ExecutionArtifactKind.BRAINSTORM : ExecutionArtifactKind.SWEEP, artifact };
}
