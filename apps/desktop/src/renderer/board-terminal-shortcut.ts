/**
 * Pure helper for the standalone Kanban Board's `Ctrl+f` shortcut, which
 * should attach the live PTY terminal for the focused Task.
 *
 * In M2 the board window is a separate `BrowserWindow` and does not own the
 * terminal surface directly. The plan calls for deferring real terminal
 * attach to a follow-up: this module returns a discriminated outcome the
 * entry can render to the user (no-op vs. needs-main-window) so callers can
 * stay pure-testable and the UX is honest about the limitation.
 */

import type { BoardFocus } from './board-keyboard';
import type { BoardColumnProjection } from './board-view';

export type BoardTerminalShortcutOutcome =
  | { readonly kind: 'focused-task'; readonly taskId: string }
  | { readonly kind: 'no-task-focused' }
  | { readonly kind: 'requires-main-window'; readonly taskId: string };

/**
 * Decides what should happen when the user presses `Ctrl+f` while the board
 * has the focused cell given in {@link focus}.
 *
 * Rules:
 *  - When no card is focused at the current focus, return `no-task-focused`.
 *  - When the focused Task is already attached in the current renderer, we
 *    do not know that here (the controller owns the mapping), so we ask the
 *    caller to switch to the main window — which is the only window that
 *    owns the terminal surface in the current architecture.
 */
export function decideBoardTerminalAction(
  focus: BoardFocus,
  columns: readonly BoardColumnProjection[],
): BoardTerminalShortcutOutcome {
  const column = columns[focus.columnIndex];
  if (column === undefined) {
    return { kind: 'no-task-focused' };
  }
  const task = column.tasks[focus.rowIndex];
  if (task === undefined) {
    return { kind: 'no-task-focused' };
  }
  return { kind: 'requires-main-window', taskId: task.task.id };
}
