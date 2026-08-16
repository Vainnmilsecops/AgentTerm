/**
 * Renderer-only pure decision for the right-click menu on the terminal pane.
 *
 * The visual menu is rendered by {@link TerminalContextMenu} and dispatched from
 * each pane's host element. This module decides which menu items are enabled
 * given the current terminal selection state. It deliberately does not interact
 * with the clipboard; the render layer calls `terminal.paste()` or copies the
 * selection through xterm.
 */

export interface ContextMenuInput {
  readonly hasSelection: boolean;
  readonly mode: 'copy' | 'paste' | 'select-all';
}

export interface ContextMenuAction {
  readonly enabled: boolean;
  readonly kind: ContextMenuInput['mode'];
}

export interface TerminalContextMenuAction extends ContextMenuAction {
  readonly label: string;
}

export function decideContextMenuAction(input: ContextMenuInput): ContextMenuAction {
  if (input.mode === 'copy') {
    return { enabled: input.hasSelection, kind: 'copy' };
  }
  if (input.mode === 'paste') {
    return { enabled: true, kind: 'paste' };
  }
  return { enabled: true, kind: 'select-all' };
}

export function buildContextMenuActions(selection: string): readonly TerminalContextMenuAction[] {
  return Object.freeze([
    Object.freeze({ ...decideContextMenuAction({ hasSelection: selection.length > 0, mode: 'copy' }), label: 'Copy' }),
    Object.freeze({ ...decideContextMenuAction({ hasSelection: selection.length > 0, mode: 'paste' }), label: 'Paste' }),
    Object.freeze({ ...decideContextMenuAction({ hasSelection: selection.length > 0, mode: 'select-all' }), label: 'Select all' }),
  ] as TerminalContextMenuAction[]);
}
