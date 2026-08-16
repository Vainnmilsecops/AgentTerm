import { useEffect, useState } from 'react';

import type {
  TerminalContextMenuAction,
} from './terminal-context-menu';

export interface TerminalContextMenuProps {
  readonly actions: readonly TerminalContextMenuAction[];
  readonly onSelect: (action: TerminalContextMenuAction) => void;
  readonly position: { readonly x: number; readonly y: number } | undefined;
}

export function TerminalContextMenu({ actions, onSelect, position }: TerminalContextMenuProps) {
  if (position === undefined) return null;
  return (
    <ul
      aria-label="Terminal context menu"
      className="terminal-context-menu"
      data-terminal-context-menu
      role="menu"
      style={{ left: position.x, position: 'fixed', top: position.y }}
    >
      {actions.map((action) => (
        <li key={action.kind} role="none">
          <button
            aria-disabled={!action.enabled}
            className="terminal-context-menu__item"
            disabled={!action.enabled}
            onClick={() => {
              if (action.enabled) onSelect(action);
            }}
            role="menuitem"
            type="button"
          >
            {action.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface UseTerminalContextMenuOptions {
  readonly enabled: boolean;
  readonly onClose: () => void;
  readonly resolveActions: (selection: string) => readonly TerminalContextMenuAction[];
  readonly target: HTMLElement | null;
}

export interface UseTerminalContextMenuResult {
  readonly actions: readonly TerminalContextMenuAction[];
  readonly position: { readonly x: number; readonly y: number } | undefined;
  readonly selection: string;
  readonly dismiss: () => void;
}

export function useTerminalContextMenu(
  options: UseTerminalContextMenuOptions,
): UseTerminalContextMenuResult {
  const [position, setPosition] = useState<{ x: number; y: number } | undefined>(undefined);
  const [selection, setSelection] = useState('');

  useEffect(() => {
    if (!options.enabled || options.target === null) return undefined;
    const target = options.target;
    const onContextMenu = (event: MouseEvent): void => {
      const inside = target.contains(event.target as Node);
      if (!inside) return;
      event.preventDefault();
      const selectionText = readWindowSelection();
      setSelection(selectionText);
      setPosition({ x: event.clientX, y: event.clientY });
    };
    const onDismiss = (event: MouseEvent): void => {
      const targetNode = event.target as HTMLElement | null;
      if (targetNode === null) return;
      const menu = targetNode.closest('[data-terminal-context-menu]');
      if (menu !== null) return;
      setPosition(undefined);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setPosition(undefined);
      }
    };
    target.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('mousedown', onDismiss);
    document.addEventListener('keydown', onEscape);
    return () => {
      target.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('mousedown', onDismiss);
      document.removeEventListener('keydown', onEscape);
    };
  }, [options.enabled, options.target]);

  const dismiss = (): void => {
    setPosition(undefined);
    options.onClose();
  };

  return {
    actions: options.resolveActions(selection),
    dismiss,
    position,
    selection,
  };
}

function readWindowSelection(): string {
  if (typeof window === 'undefined') return '';
  return window.getSelection?.().toString() ?? '';
}
