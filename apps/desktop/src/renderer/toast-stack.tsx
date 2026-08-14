import type { ReactNode } from 'react';

import type { Toast } from './toast';

export interface ToastStackProps {
  readonly onDismiss: (id: string) => void;
  readonly toasts: readonly Toast[];
}

export function ToastStack({ onDismiss, toasts }: ToastStackProps): ReactNode {
  if (toasts.length === 0) {
    return null;
  }
  return (
    <div className="toast-stack" data-toast-stack aria-live="polite">
      {toasts.map((toast) => (
        <div
          aria-label={toast.message}
          className={`toast toast--${toast.tone}`}
          data-toast
          key={toast.id}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
        >
          <span className="toast__message">{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            className="toast__dismiss"
            onClick={() => onDismiss(toast.id)}
            type="button"
          >
            {'\u00d7'}
          </button>
        </div>
      ))}
    </div>
  );
}
