export type ToastTone = 'danger' | 'info' | 'success';

export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: ToastTone;
}

export interface ToastSequence {
  readonly id: string;
  readonly label: string;
  readonly tone: ToastTone;
}

const TOAST_LIFESPAN_MS = 3200;

export function createToastRegistry(): {
  readonly dismiss: (id: string) => void;
  readonly getToasts: () => readonly Toast[];
  readonly push: (toast: Omit<Toast, 'id'>) => string;
} {
  const listeners = new Set<() => void>();
  const toasts: Toast[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const dismiss = (id: string): void => {
    const index = toasts.findIndex((toast) => toast.id === id);
    if (index === -1) {
      return;
    }
    toasts.splice(index, 1);
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    notify();
  };

  const push = (toast: Omit<Toast, 'id'>): string => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    toasts.push({ ...toast, id });
    const timer = setTimeout(() => dismiss(id), TOAST_LIFESPAN_MS);
    timers.set(id, timer);
    notify();
    return id;
  };

  return {
    dismiss,
    getToasts: () => toasts.slice(),
    push,
  };
}

export function toastForAction(label: string, tone: ToastTone = 'success'): Omit<Toast, 'id'> {
  const pastTense = label.endsWith('e') ? `${label}d` : `${label}ed`;
  return {
    message: pastTense.charAt(0).toUpperCase() + pastTense.slice(1),
    tone,
  };
}