import { useState, type FormEvent } from 'react';

export interface DestructiveConfirmProps {
  readonly busy: boolean;
  readonly confirmLabel: string;
  readonly expectedName: string;
  readonly message?: string;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly title: string;
}

export function DestructiveConfirm({
  busy,
  confirmLabel,
  expectedName,
  message,
  onCancel,
  onConfirm,
  title,
}: DestructiveConfirmProps) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === expectedName;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (matches && !busy) {
      onConfirm();
    }
  };
  return (
    <div
      className="destructive-confirm"
      data-destructive-confirm
      role="alertdialog"
      aria-labelledby="destructive-confirm-title"
    >
      <h3 id="destructive-confirm-title">{title}</h3>
      {message === undefined ? null : <p className="destructive-confirm__message">{message}</p>}
      <p className="destructive-confirm__prompt">
        Type <code>{expectedName}</code> to confirm.
      </p>
      <form onSubmit={submit}>
        <input
          aria-describedby="destructive-confirm-title"
          autoComplete="off"
          data-destructive-confirm-input
          disabled={busy}
          onChange={(event) => setTyped(event.currentTarget.value)}
          spellCheck={false}
          type="text"
          value={typed}
        />
        <div className="destructive-confirm__actions">
          <button disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="primary-action primary-action--danger"
            data-destructive-confirm-action
            disabled={busy || !matches}
            type="submit"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
