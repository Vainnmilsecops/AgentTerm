import { useCallback, useEffect, useState } from 'react';

/**
 * Renderer-only pure decision for the right-click menu on the terminal pane.
 *
 * The visual menu is rendered by {@link TerminalContextMenu} and dispatched from
 * each pane's host element. This module decides which menu items are enabled
 * given the current terminal selection state and (optionally) agent session status.
 * It deliberately does not interact with the clipboard or session lifecycle; the
 * render layer calls `terminal.paste()` or copies the selection through xterm,
 * and routes agent actions through the application layer.
 */

/** Built-in terminal operations available in every state. */
export type TerminalContextMenuKind = 'copy' | 'paste' | 'select-all';

/** Agent-aware operations shown when a live session is attached. */
export type AgentContextMenuKind = 'agent-stop' | 'agent-signal';

export type ContextMenuKind = TerminalContextMenuKind | AgentContextMenuKind;

export interface ContextMenuInput {
  readonly hasSelection: boolean;
  readonly kind: ContextMenuKind;
}

export interface ContextMenuAction {
  readonly enabled: boolean;
  readonly kind: ContextMenuKind;
}

export interface TerminalContextMenuAction extends ContextMenuAction {
  readonly label: string;
  /** Section label shown above the item group. */
  readonly section?: string;
}

export function decideContextMenuAction(input: ContextMenuInput): ContextMenuAction {
  if (input.kind === 'copy') {
    return { enabled: input.hasSelection, kind: 'copy' };
  }
  if (input.kind === 'paste') {
    return { enabled: true, kind: 'paste' };
  }
  if (input.kind === 'select-all') {
    return { enabled: true, kind: 'select-all' };
  }
  if (input.kind === 'agent-stop') {
    return { enabled: true, kind: 'agent-stop' };
  }
  if (input.kind === 'agent-signal') {
    return { enabled: true, kind: 'agent-signal' };
  }
  return { enabled: false, kind: 'copy' };
}

export interface MenuContext {
  readonly hasSelection: boolean;
  readonly sessionId: string | undefined;
}

export type ResolveContextMenuActions = (context: MenuContext) => readonly TerminalContextMenuAction[];

/**
 * Build the complete ordered menu actions: terminal essentials first,
 * then agent actions when a session is attached.
 */
export function buildContextMenuActions(
  sessionId: string | undefined,
  hasSelection: boolean,
): readonly TerminalContextMenuAction[] {
  const terminalActions: readonly TerminalContextMenuAction[] = [
    Object.freeze({
      ...decideContextMenuAction({ hasSelection, kind: 'copy' }),
      label: 'Copy',
    }),
    Object.freeze({
      ...decideContextMenuAction({ hasSelection, kind: 'paste' }),
      label: 'Paste',
    }),
    Object.freeze({
      ...decideContextMenuAction({ hasSelection, kind: 'select-all' }),
      label: 'Select all',
    }),
  ];

  if (sessionId === undefined) {
    return terminalActions;
  }

  return [
    ...terminalActions,
    Object.freeze({
      ...decideContextMenuAction({ hasSelection, kind: 'agent-stop' }),
      label: 'Stop Agent',
      section: 'Agent Session',
    }),
    Object.freeze({
      ...decideContextMenuAction({ hasSelection, kind: 'agent-signal' }),
      label: 'Send Signal (Ctrl+C)',
      section: 'Agent Session',
    }),
  ];
}

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
      {actions.map((action, index) => (
        <li key={action.kind} role="none">
          {action.section !== undefined && index > 0 && index === findSectionStart(actions, index) ? (
            <div className="terminal-context-menu__separator" role="separator" />
          ) : null}
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

/** Returns the index of the first item in a new section (section differs from previous). */
function findSectionStart(
  actions: readonly TerminalContextMenuAction[],
  index: number,
): number {
  const current = actions[index];
  if (current === undefined) return index;
  for (let i = index - 1; i >= 0; i--) {
    const prev = actions[i];
    if (prev === undefined || prev.section !== current.section) {
      return i + 1;
    }
  }
  return 0;
}

export interface UseTerminalContextMenuOptions {
  readonly enabled: boolean;
  readonly onClose: () => void;
  readonly resolveActions: ResolveContextMenuActions;
  readonly sessionId: string | undefined;
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

  const dismiss = useCallback(() => {
    setPosition(undefined);
    options.onClose();
  }, [options.onClose]);

  const actions = options.resolveActions({
    hasSelection: selection.length > 0,
    sessionId: options.sessionId,
  });

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

  return {
    actions,
    dismiss,
    position,
    selection,
  };
}

function readWindowSelection(): string {
  if (typeof window === 'undefined') return '';
  return window.getSelection?.()?.toString() ?? '';
}
