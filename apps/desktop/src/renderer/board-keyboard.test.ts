import { describe, expect, it } from 'vitest';

import {
  BOARD_PHASE_ORDER,
  decodeBoardFocusHash,
  encodeBoardFocusHash,
  initialBoardFocus,
  projectColumnSizes,
  reduceBoardKeyboard,
  resolveBoardKeyboardKey,
  resolveFocusedTaskId,
} from './board-keyboard';
import { decideBoardTerminalAction } from './board-terminal-shortcut';
import type { BoardColumnProjection } from './board-view';

function makeColumn(phase: string, taskIds: readonly string[]): BoardColumnProjection {
  return Object.freeze({
    column: Object.freeze({ id: phase as never, title: phase }),
    tasks: Object.freeze(
      taskIds.map((id) =>
        Object.freeze({
          activeSession: undefined,
          artifacts: [],
          canAcceptPlan: false,
          canBeginPlanning: false,
          canProduceArtifact: false,
          canRequestReview: false,
          canRetryExecution: false,
          canRevisePlan: false,
          canRunQualityGate: false,
          canStartExecution: false,
          canStartPlanning: false,
          dependencies: [],
          hasOpenReview: false,
          latestPlan: undefined,
          latestReview: undefined,
          plugin: undefined,
          reviewEvidence: undefined,
          task: Object.freeze({
            brief: '',
            createdAt: 0,
            id,
            phase: phase as never,
            projectId: 'p1',
            revision: 0,
            title: id,
            updatedAt: 0,
          }),
          workflowPlugin: undefined,
        } as unknown as import('@agentterm/application').WorkspaceTaskOverview),
      ),
    ),
  });
}

describe('reduceBoardKeyboard', () => {
  // Column sizes: [BACKLOG=3, PLANNING=1, RUNNING=0, REVIEW=2, DONE=0]
  const sizes = Object.freeze([3, 1, 0, 2, 0]);

  it('clamps MOVE_LEFT at column 0', () => {
    const next = reduceBoardKeyboard(initialBoardFocus, { kind: 'MOVE_LEFT' }, sizes);
    expect(next).toEqual({ columnIndex: 0, rowIndex: 0 });
  });

  it('MOVE_RIGHT moves to next column and resets row to 0', () => {
    const start = { columnIndex: 0, rowIndex: 2 };
    const next = reduceBoardKeyboard(start, { kind: 'MOVE_RIGHT' }, sizes);
    expect(next).toEqual({ columnIndex: 1, rowIndex: 0 });
  });

  it('MOVE_LEFT moves to previous column and resets row to 0', () => {
    const start = { columnIndex: 3, rowIndex: 1 };
    const next = reduceBoardKeyboard(start, { kind: 'MOVE_LEFT' }, sizes);
    expect(next).toEqual({ columnIndex: 2, rowIndex: 0 });
  });

  it('MOVE_UP clamps to row 0 and stays in same column', () => {
    const start = { columnIndex: 3, rowIndex: 1 };
    const next = reduceBoardKeyboard(start, { kind: 'MOVE_UP' }, sizes);
    expect(next).toEqual({ columnIndex: 3, rowIndex: 0 });
  });

  it('MOVE_DOWN clamps to last row of column', () => {
    const start = { columnIndex: 3, rowIndex: 0 };
    const next = reduceBoardKeyboard(start, { kind: 'MOVE_DOWN' }, sizes);
    expect(next).toEqual({ columnIndex: 3, rowIndex: 1 });
    const further = reduceBoardKeyboard(next, { kind: 'MOVE_DOWN' }, sizes);
    expect(further).toEqual({ columnIndex: 3, rowIndex: 1 });
  });

  it('MOVE_DOWN in an empty column leaves rowIndex at 0', () => {
    const start = { columnIndex: 2, rowIndex: 0 }; // column RUNNING has 0 rows
    const next = reduceBoardKeyboard(start, { kind: 'MOVE_DOWN' }, sizes);
    expect(next).toEqual({ columnIndex: 2, rowIndex: 0 });
  });

  it('MOVE_RIGHT clamps at the last column', () => {
    const start = { columnIndex: 4, rowIndex: 0 };
    const next = reduceBoardKeyboard(start, { kind: 'MOVE_RIGHT' }, sizes);
    expect(next).toEqual({ columnIndex: 4, rowIndex: 0 });
  });

  it('MOVE_LEFT from column 0 stays at column 0', () => {
    const next = reduceBoardKeyboard({ columnIndex: 0, rowIndex: 0 }, { kind: 'MOVE_LEFT' }, sizes);
    expect(next).toEqual({ columnIndex: 0, rowIndex: 0 });
  });

  it('RESET moves to first column and row 0', () => {
    const next = reduceBoardKeyboard(
      { columnIndex: 2, rowIndex: 5 },
      { kind: 'RESET', columns: 5 },
      sizes,
    );
    expect(next).toEqual({ columnIndex: 0, rowIndex: 0 });
  });

  it('RESET with columnIndex moves to that column and row 0', () => {
    const next = reduceBoardKeyboard(
      { columnIndex: 0, rowIndex: 0 },
      { kind: 'RESET', columnIndex: 3, columns: 5 },
      sizes,
    );
    expect(next).toEqual({ columnIndex: 3, rowIndex: 0 });
  });

  it('returns focus at origin when there are no columns', () => {
    const next = reduceBoardKeyboard(
      { columnIndex: 0, rowIndex: 0 },
      { kind: 'MOVE_RIGHT' },
      [],
    );
    expect(next).toEqual({ columnIndex: 0, rowIndex: 0 });
  });

  it('produces a frozen BoardFocus object', () => {
    const next = reduceBoardKeyboard(initialBoardFocus, { kind: 'MOVE_RIGHT' }, sizes);
    expect(Object.isFrozen(next)).toBe(true);
  });
});

describe('resolveBoardKeyboardKey', () => {
  it('maps h to MOVE_LEFT', () => {
    expect(resolveBoardKeyboardKey({ key: 'h' })).toBe('MOVE_LEFT');
  });

  it('maps ArrowLeft to MOVE_LEFT', () => {
    expect(resolveBoardKeyboardKey({ key: 'ArrowLeft' })).toBe('MOVE_LEFT');
  });

  it('maps l and ArrowRight to MOVE_RIGHT', () => {
    expect(resolveBoardKeyboardKey({ key: 'l' })).toBe('MOVE_RIGHT');
    expect(resolveBoardKeyboardKey({ key: 'ArrowRight' })).toBe('MOVE_RIGHT');
  });

  it('maps j and ArrowDown to MOVE_DOWN', () => {
    expect(resolveBoardKeyboardKey({ key: 'j' })).toBe('MOVE_DOWN');
    expect(resolveBoardKeyboardKey({ key: 'ArrowDown' })).toBe('MOVE_DOWN');
  });

  it('maps k and ArrowUp to MOVE_UP', () => {
    expect(resolveBoardKeyboardKey({ key: 'k' })).toBe('MOVE_UP');
    expect(resolveBoardKeyboardKey({ key: 'ArrowUp' })).toBe('MOVE_UP');
  });

  it('maps Enter to ACTIVATE', () => {
    expect(resolveBoardKeyboardKey({ key: 'Enter' })).toBe('ACTIVATE');
  });

  it('maps Ctrl+f to OPEN_TERMINAL', () => {
    expect(resolveBoardKeyboardKey({ ctrlKey: true, key: 'f' })).toBe('OPEN_TERMINAL');
  });

  it('returns UNKNOWN for an unmapped key', () => {
    expect(resolveBoardKeyboardKey({ key: 'a' })).toBe('UNKNOWN');
    expect(resolveBoardKeyboardKey({ key: 'x' })).toBe('UNKNOWN');
  });

  it('returns null (ignore) when target is INPUT', () => {
    expect(
      resolveBoardKeyboardKey({ key: 'h', target: { tagName: 'INPUT' } }),
    ).toBeNull();
  });

  it('returns null when target is TEXTAREA', () => {
    expect(
      resolveBoardKeyboardKey({ key: 'h', target: { tagName: 'TEXTAREA' } }),
    ).toBeNull();
  });

  it('returns null when target is contentEditable', () => {
    expect(
      resolveBoardKeyboardKey({ key: 'l', target: { isContentEditable: true, tagName: 'DIV' } }),
    ).toBeNull();
  });

  it('returns command when target is null', () => {
    expect(resolveBoardKeyboardKey({ key: 'h', target: null })).toBe('MOVE_LEFT');
  });
});

describe('resolveFocusedTaskId', () => {
  const columns = [
    makeColumn('BACKLOG', ['t-1', 't-2']),
    makeColumn('PLANNING', ['t-3']),
    makeColumn('RUNNING', []),
  ];

  it('returns the task id at the focused cell', () => {
    expect(resolveFocusedTaskId({ columnIndex: 0, rowIndex: 1 }, columns)).toBe('t-2');
  });

  it('returns undefined when row index is out of range', () => {
    expect(resolveFocusedTaskId({ columnIndex: 0, rowIndex: 5 }, columns)).toBeUndefined();
  });

  it('returns undefined when column index is out of range', () => {
    expect(resolveFocusedTaskId({ columnIndex: 99, rowIndex: 0 }, columns)).toBeUndefined();
  });

  it('returns undefined when focused column is empty', () => {
    expect(resolveFocusedTaskId({ columnIndex: 2, rowIndex: 0 }, columns)).toBeUndefined();
  });
});

describe('hash codec', () => {
  it('round-trips encode → decode', () => {
    const focus = { columnIndex: 2, rowIndex: 4 };
    expect(decodeBoardFocusHash(`#${encodeBoardFocusHash(focus)}`)).toEqual(focus);
  });

  it('encodes without leading hash', () => {
    expect(encodeBoardFocusHash({ columnIndex: 1, rowIndex: 0 })).toBe('focus=1:0');
  });

  it('decodes the encoded form', () => {
    expect(decodeBoardFocusHash('#focus=3:7')).toEqual({ columnIndex: 3, rowIndex: 7 });
  });

  it('returns undefined for malformed hashes', () => {
    expect(decodeBoardFocusHash('#other=2:3')).toBeUndefined();
    expect(decodeBoardFocusHash('#focus=abc:1')).toBeUndefined();
    expect(decodeBoardFocusHash('#focus=-1:2')).toBeUndefined();
    expect(decodeBoardFocusHash('')).toBeUndefined();
  });
});

describe('projectColumnSizes', () => {
  it('returns the number of tasks in each column in order', () => {
    const columns = [
      makeColumn('BACKLOG', ['a', 'b', 'c']),
      makeColumn('PLANNING', ['d']),
      makeColumn('RUNNING', []),
    ];
    expect(projectColumnSizes(columns)).toEqual([3, 1, 0]);
  });

  it('returns an empty array for an empty projection', () => {
    expect(projectColumnSizes([])).toEqual([]);
  });
});

describe('decideBoardTerminalAction', () => {
  const columns = [
    makeColumn('BACKLOG', ['t-1', 't-2']),
    makeColumn('PLANNING', ['t-3']),
  ];

  it('returns requires-main-window for a focused task', () => {
    expect(decideBoardTerminalAction({ columnIndex: 0, rowIndex: 1 }, columns)).toEqual({
      kind: 'requires-main-window',
      taskId: 't-2',
    });
  });

  it('returns no-task-focused when column index is out of range', () => {
    expect(decideBoardTerminalAction({ columnIndex: 99, rowIndex: 0 }, columns)).toEqual({
      kind: 'no-task-focused',
    });
  });

  it('returns no-task-focused when row index is out of range', () => {
    expect(decideBoardTerminalAction({ columnIndex: 0, rowIndex: 99 }, columns)).toEqual({
      kind: 'no-task-focused',
    });
  });
});

describe('BOARD_PHASE_ORDER', () => {
  it('lists the five canonical phases in BACKLOG → DONE order', () => {
    expect(BOARD_PHASE_ORDER).toEqual(['BACKLOG', 'PLANNING', 'RUNNING', 'REVIEW', 'DONE']);
  });
});
