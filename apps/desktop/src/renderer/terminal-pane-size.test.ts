import { describe, expect, it } from 'vitest';

import { DEFAULT_TERMINAL_HEIGHT, resizeTerminalHeight } from './terminal-pane-size';

describe('terminal pane vertical resizing', () => {
  it('starts as a bounded rectangle and grows when its top edge moves upward', () => {
    expect(DEFAULT_TERMINAL_HEIGHT).toBe(360);
    expect(resizeTerminalHeight(360, 500, 420, 900)).toBe(440);
  });

  it('shrinks when its top edge moves downward and clamps both extremes', () => {
    expect(resizeTerminalHeight(360, 500, 700, 900)).toBe(240);
    expect(resizeTerminalHeight(360, 500, -500, 900)).toBe(720);
  });
});
