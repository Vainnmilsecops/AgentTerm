import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TERMINAL_HEIGHT,
  MAX_TERMINAL_VIEWPORT_OFFSET,
  MIN_TERMINAL_HEIGHT,
  maximumTerminalHeight,
  resizeTerminalHeight,
} from './terminal-pane-size';

describe('terminal pane vertical resizing', () => {
  it('starts as a bounded rectangle and grows when its top edge moves upward', () => {
    expect(DEFAULT_TERMINAL_HEIGHT).toBe(264);
    expect(resizeTerminalHeight(264, 500, 420, 900)).toBe(344);
  });

  it('shrinks when its top edge moves downward and clamps both extremes', () => {
    expect(resizeTerminalHeight(264, 500, 700, 900)).toBe(MIN_TERMINAL_HEIGHT);
    expect(resizeTerminalHeight(264, 500, -500, 900)).toBe(900 - MAX_TERMINAL_VIEWPORT_OFFSET);
  });

  it('never exposes a value above the ARIA maximum at the minimum Electron height', () => {
    const viewportHeight = 480;
    const viewportWidth = 520;
    const maximum = maximumTerminalHeight(viewportHeight, viewportWidth);
    expect(maximum).toBe(MIN_TERMINAL_HEIGHT);
    expect(resizeTerminalHeight(640, 0, 0, viewportHeight, viewportWidth)).toBe(maximum);
  });

  it('reserves more Kanban space at narrow desktop widths', () => {
    expect(maximumTerminalHeight(640, 760)).toBe(224);
    expect(maximumTerminalHeight(900, 1600)).toBe(900 - MAX_TERMINAL_VIEWPORT_OFFSET);
  });
});
