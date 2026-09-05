/**
 * Pure reducer + key resolver for the standalone Kanban Board's
 * keyboard navigation (M2). Keeping this logic pure means the renderer can
 * `useReducer(reduceBoardKeyboard, initialBoardFocus)` and the entry can wire
 * the DOM `keydown` listener without dragging React or any DOM dependency
 * into this file.
 *
 * Conventions:
 *  - Column / row indices are clamped to the bounds of the projection; the
 *    reducer never returns out-of-range coordinates.
 *  - Column sizes are the number of Task cards in each column, in column
 *    order. When the new column has fewer rows than the previous row index,
 *    the row is clamped to the new column's last row.
 *  - `RESET` returns focus to column `columnIndex` (default 0), row 0.
 */

import { TaskPhase } from '@agentterm/application';

import type { BoardColumnProjection } from './board-view';

export interface BoardFocus {
  readonly columnIndex: number;
  readonly rowIndex: number;
}

export type BoardKeyboardAction =
  | { readonly kind: 'MOVE_LEFT' | 'MOVE_RIGHT' }
  | { readonly kind: 'MOVE_UP' | 'MOVE_DOWN' }
  | { readonly kind: 'RESET'; readonly columnIndex?: number; readonly columns: number };

export type BoardKeyboardCommand =
  | 'ACTIVATE'
  | 'MOVE_DOWN'
  | 'MOVE_LEFT'
  | 'MOVE_RIGHT'
  | 'MOVE_UP'
  | 'OPEN_TERMINAL'
  | 'UNKNOWN';

/** Inputs the DOM event resolver consumes. Mirrors KeyboardEvent subset. */
export interface BoardKeyboardEventInput {
  readonly ctrlKey?: boolean;
  readonly key: string;
  readonly target?: {
    readonly isContentEditable?: boolean;
    readonly tagName?: string;
  } | null;
}

export const initialBoardFocus: BoardFocus = Object.freeze({ columnIndex: 0, rowIndex: 0 });

/**
 * Pure reducer: given a focus state, an action, and the column sizes for the
 * current board projection, return the next focus state clamped to bounds.
 */
export function reduceBoardKeyboard(
  focus: BoardFocus,
  action: BoardKeyboardAction,
  columnSizes: readonly number[],
): BoardFocus {
  const columnCount = columnSizes.length;
  if (columnCount === 0) {
    return Object.freeze({ columnIndex: 0, rowIndex: 0 });
  }

  if (action.kind === 'RESET') {
    const targetColumn = clamp(action.columnIndex ?? 0, 0, columnCount - 1);
    return Object.freeze({ columnIndex: targetColumn, rowIndex: 0 });
  }

  switch (action.kind) {
    case 'MOVE_LEFT': {
      const nextColumn = clamp(focus.columnIndex - 1, 0, columnCount - 1);
      return Object.freeze({ ...focus, columnIndex: nextColumn, rowIndex: 0 });
    }
    case 'MOVE_RIGHT': {
      const nextColumn = clamp(focus.columnIndex + 1, 0, columnCount - 1);
      return Object.freeze({ ...focus, columnIndex: nextColumn, rowIndex: 0 });
    }
    case 'MOVE_UP': {
      const currentSize = columnSizes[focus.columnIndex] ?? 0;
      const nextRow = clamp(focus.rowIndex - 1, 0, Math.max(0, currentSize - 1));
      return Object.freeze({ ...focus, rowIndex: nextRow });
    }
    case 'MOVE_DOWN': {
      const currentSize = columnSizes[focus.columnIndex] ?? 0;
      const nextRow = clamp(focus.rowIndex + 1, 0, Math.max(0, currentSize - 1));
      return Object.freeze({ ...focus, rowIndex: nextRow });
    }
  }
}

/**
 * Resolves a DOM keyboard event into a discriminated command the renderer
 * can route to the reducer or to activate/open-terminal handlers.
 *
 * Returns `UNKNOWN` for keys we do not handle so the caller can fall back to
 * the browser's default behavior. Returns `null` when the event should be
 * ignored (composing / editable targets) so the caller can stop propagation.
 */
export function resolveBoardKeyboardKey(
  input: BoardKeyboardEventInput,
): BoardKeyboardCommand | null {
  if (isEditableTarget(input.target)) {
    return null;
  }
  if (input.ctrlKey === true && input.key === 'f') {
    return 'OPEN_TERMINAL';
  }
  switch (input.key) {
    case 'h':
    case 'ArrowLeft':
      return 'MOVE_LEFT';
    case 'l':
    case 'ArrowRight':
      return 'MOVE_RIGHT';
    case 'k':
    case 'ArrowUp':
      return 'MOVE_UP';
    case 'j':
    case 'ArrowDown':
      return 'MOVE_DOWN';
    case 'Enter':
      return 'ACTIVATE';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Returns the Task id that the given focus currently points at, or
 * `undefined` if no such Task exists. Pure helper used by BoardEntry and the
 * terminal-shortcut resolver.
 */
export function resolveFocusedTaskId(
  focus: BoardFocus,
  columns: readonly BoardColumnProjection[],
): string | undefined {
  const column = columns[focus.columnIndex];
  if (column === undefined) return undefined;
  const task = column.tasks[focus.rowIndex];
  if (task === undefined) return undefined;
  return task.task.id;
}

/**
 * Decodes a `#focus=<column>:<row>` URL hash into a {@link BoardFocus}. The
 * encoding is documented and stable so the board URL is link-shareable.
 */
export function decodeBoardFocusHash(hash: string): BoardFocus | undefined {
  if (!hash.startsWith('#focus=')) return undefined;
  const body = hash.slice('#focus='.length);
  const [columnPart, rowPart] = body.split(':');
  if (columnPart === undefined || rowPart === undefined) return undefined;
  const column = Number.parseInt(columnPart, 10);
  const row = Number.parseInt(rowPart, 10);
  if (!Number.isInteger(column) || !Number.isInteger(row)) return undefined;
  if (column < 0 || row < 0) return undefined;
  return Object.freeze({ columnIndex: column, rowIndex: row });
}

/**
 * Encodes the current {@link BoardFocus} into the URL hash fragment. The
 * output omits the leading `#` so the caller can decide whether to set
 * `location.hash = '#' + encodeBoardFocusHash(...)`.
 */
export function encodeBoardFocusHash(focus: BoardFocus): string {
  return `focus=${focus.columnIndex}:${focus.rowIndex}`;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function isEditableTarget(
  target: BoardKeyboardEventInput['target'],
): boolean {
  if (target === null || target === undefined) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName;
  if (tag === undefined) return false;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Returns the column sizes for a board projection — i.e. the number of cards
 * in each column, in column order. Surface as a named helper so the entry can
 * compute it once per render without duplicating the loop.
 */
export function projectColumnSizes(
  columns: readonly BoardColumnProjection[],
): readonly number[] {
  return Object.freeze(columns.map((column) => column.tasks.length));
}

/**
 * Stable column id list for the board. The keyboard reducer uses indices, but
 * callers occasionally want to render the focused column's phase id (e.g. for
 * ARIA labels).
 */
export const BOARD_PHASE_ORDER: readonly TaskPhase[] = Object.freeze([
  TaskPhase.BACKLOG,
  TaskPhase.PLANNING,
  TaskPhase.RUNNING,
  TaskPhase.REVIEW,
  TaskPhase.DONE,
]);
