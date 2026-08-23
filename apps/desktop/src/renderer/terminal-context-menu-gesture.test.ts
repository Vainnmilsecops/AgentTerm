import { describe, expect, it } from 'vitest';

import {
  CONTEXT_MENU_FORWARD_HINT,
  decideContextMenuGesture,
} from './terminal-context-menu-gesture';

describe('decideContextMenuGesture', () => {
  it('forwards Shift + right-click to the TUI', () => {
    expect(
      decideContextMenuGesture({ button: 2, ctrlKey: false, metaKey: false, shiftKey: true }),
    ).toBe('forward-to-tui');
  });

  it('shows the AgentTerm menu on plain right-click', () => {
    expect(
      decideContextMenuGesture({ button: 2, ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toBe('show-menu');
  });

  it('does not flip the gesture when only Ctrl is held', () => {
    expect(
      decideContextMenuGesture({ button: 2, ctrlKey: true, metaKey: false, shiftKey: true }),
    ).toBe('show-menu');
  });

  it('does not flip the gesture when only Meta is held', () => {
    expect(
      decideContextMenuGesture({ button: 2, ctrlKey: false, metaKey: true, shiftKey: true }),
    ).toBe('show-menu');
  });

  it('shows the menu for left-button (button 0)', () => {
    expect(
      decideContextMenuGesture({ button: 0, ctrlKey: false, metaKey: false, shiftKey: true }),
    ).toBe('show-menu');
  });

  it('shows the menu for middle-button (button 1)', () => {
    expect(
      decideContextMenuGesture({ button: 1, ctrlKey: false, metaKey: false, shiftKey: true }),
    ).toBe('show-menu');
  });

  it('shows the menu when no modifiers are set', () => {
    expect(
      decideContextMenuGesture({ button: 2, ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toBe('show-menu');
  });
});

describe('CONTEXT_MENU_FORWARD_HINT', () => {
  it('is a non-empty stable string', () => {
    expect(typeof CONTEXT_MENU_FORWARD_HINT).toBe('string');
    expect(CONTEXT_MENU_FORWARD_HINT.length).toBeGreaterThan(0);
    expect(CONTEXT_MENU_FORWARD_HINT).toContain('Shift');
  });
});