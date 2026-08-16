import { describe, expect, it } from 'vitest';

import {
  decideKeyOutcome,
  type KeyboardEventLike,
  type Modifier,
  type TerminalKeyOutcome,
} from './terminal-keyboard-controller';

interface Case {
  readonly key: string;
  readonly shift: boolean;
  readonly modifier: Modifier;
  readonly selection: boolean;
  readonly composing: boolean;
  readonly expected: TerminalKeyOutcome;
  readonly label: string;
}

const CTRL: Modifier = { ctrl: true, meta: false };
const CMD: Modifier = { ctrl: false, meta: true };
const NONE: Modifier = { ctrl: false, meta: false };

const cases: readonly Case[] = [
  // Ctrl+C with selection => copy
  { key: 'C', modifier: CTRL, shift: false, selection: true, composing: false, expected: 'COPY', label: 'Ctrl+C with selection copies' },
  // Ctrl+C without selection => send ETX
  { key: 'C', modifier: CTRL, shift: false, selection: false, composing: false, expected: 'SEND_BYTES', label: 'Ctrl+C without selection sends ETX' },
  // Ctrl+Shift+C always copies
  { key: 'C', modifier: CTRL, shift: true, selection: false, composing: false, expected: 'COPY', label: 'Ctrl+Shift+C copies regardless of selection' },
  { key: 'C', modifier: CTRL, shift: true, selection: true, composing: false, expected: 'COPY', label: 'Ctrl+Shift+C with selection copies' },
  // Ctrl+Insert always copies
  { key: 'Insert', modifier: CTRL, shift: false, selection: false, composing: false, expected: 'COPY', label: 'Ctrl+Insert copies' },
  { key: 'Insert', modifier: CTRL, shift: true, selection: false, composing: false, expected: 'PASTE', label: 'Ctrl+Shift+Insert pastes' },
  // Ctrl+V / Ctrl+Shift+V paste
  { key: 'V', modifier: CTRL, shift: false, selection: false, composing: false, expected: 'PASTE', label: 'Ctrl+V pastes' },
  { key: 'V', modifier: CTRL, shift: true, selection: false, composing: false, expected: 'PASTE', label: 'Ctrl+Shift+V pastes' },
  // Cmd on mac behaves like Ctrl
  { key: 'C', modifier: CMD, shift: false, selection: true, composing: false, expected: 'COPY', label: 'Cmd+C with selection copies' },
  { key: 'C', modifier: CMD, shift: false, selection: false, composing: false, expected: 'SEND_BYTES', label: 'Cmd+C without selection sends ETX' },
  { key: 'C', modifier: CMD, shift: true, selection: false, composing: false, expected: 'COPY', label: 'Cmd+Shift+C copies' },
  // IME composing => ignore
  { key: 'C', modifier: CTRL, shift: false, selection: false, composing: true, expected: 'IGNORE', label: 'IME composing ignores Ctrl+C' },
  { key: 'V', modifier: CTRL, shift: false, selection: false, composing: true, expected: 'IGNORE', label: 'IME composing ignores Ctrl+V' },
  // Unrelated keys => ignore
  { key: 'A', modifier: CTRL, shift: false, selection: false, composing: false, expected: 'IGNORE', label: 'Ctrl+A is ignored' },
  { key: 'Enter', modifier: NONE, shift: false, selection: false, composing: false, expected: 'IGNORE', label: 'Enter is ignored' },
];

describe('decideKeyOutcome', () => {
  for (const c of cases) {
    it(c.label, () => {
      const event: KeyboardEventLike = {
        composing: c.composing,
        ctrlKey: c.modifier.ctrl,
        key: c.key,
        metaKey: c.modifier.meta,
        shiftKey: c.shift,
      };
      expect(decideKeyOutcome(event, { hasSelection: c.selection })).toBe(c.expected);
    });
  }
});

describe('decideKeyOutcome — lowercase and keyCode 229', () => {
  it('treats key=Process as composing', () => {
    const event: KeyboardEventLike = {
      composing: false,
      ctrlKey: true,
      key: 'Process',
      keyCode: 229,
      metaKey: false,
      shiftKey: false,
    };
    expect(decideKeyOutcome(event, { hasSelection: false })).toBe('IGNORE');
  });

  it('always treats keyCode 229 as composing', () => {
    const event: KeyboardEventLike = {
      composing: false,
      ctrlKey: true,
      key: 'V',
      keyCode: 229,
      metaKey: false,
      shiftKey: false,
    };
    expect(decideKeyOutcome(event, { hasSelection: false })).toBe('IGNORE');
  });

  it('normalizes "c" to "C"', () => {
    const event: KeyboardEventLike = {
      composing: false,
      ctrlKey: true,
      key: 'c',
      metaKey: false,
      shiftKey: false,
    };
    expect(decideKeyOutcome(event, { hasSelection: true })).toBe('COPY');
  });
});

describe('decideKeyOutcome — selector modes', () => {
  it('hasSelection: true enforces copy on Ctrl+C only when no Shift', () => {
    const event: KeyboardEventLike = {
      composing: false,
      ctrlKey: true,
      key: 'C',
      metaKey: false,
      shiftKey: false,
    };
    expect(decideKeyOutcome(event, { hasSelection: true })).toBe('COPY');
    expect(decideKeyOutcome(event, { hasSelection: false })).toBe('SEND_BYTES');
  });

  it('with no active modifier platform, a Ctrl+V with Cmd+V is still recognised', () => {
    const event: KeyboardEventLike = {
      composing: false,
      ctrlKey: false,
      key: 'V',
      metaKey: true,
      shiftKey: false,
    };
    expect(decideKeyOutcome(event, { hasSelection: false })).toBe('PASTE');
  });
});
