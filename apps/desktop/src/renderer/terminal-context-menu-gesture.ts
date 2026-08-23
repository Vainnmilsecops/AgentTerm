/**
 * Pure decision for the right-click gesture inside a terminal pane.
 *
 * xterm.js 6.0.0 implements mouse forwarding internally: when the
 * active TUI emits `CSI ? 1000h` / `1002h` / `1003h`, xterm encodes
 * button events into the requested protocol (SGR extended preferred
 * over UTF-8 basic) and writes them to the PTY. Renderer consumers
 * only have to decide when to step out of xterm's way so a button-2
 * press reaches the TUI.
 *
 * The convention every popular emulator (gnome-terminal, kitty,
 * iTerm2, Windows Terminal, Alacritty, WezTerm) follows is:
 *
 *   - plain right-click -> host emulator's own context menu
 *   - Shift + right-click -> forward to the active TUI as button-2
 *
 * AgentTerm follows the same convention. The decision is intentionally
 * narrow: only Shift flips the priority; Ctrl / Alt / Meta do not.
 * xterm itself listens on `mousedown` / `mouseup` for the actual
 * forwarding, so this module only has to choose whether the
 * `contextmenu` event handler suppresses the AgentTerm menu.
 */

export type ContextMenuGestureKind = 'show-menu' | 'forward-to-tui';

export interface ContextMenuGestureInput {
  /**
   * Standard `MouseEvent.button`:
   * 0 = primary (left), 1 = auxiliary (middle), 2 = secondary (right).
   * Defaults to 2 because the host calls this from the `contextmenu`
   * handler, where the button is always right.
   */
  readonly button: number;
  /** True when Ctrl is held. Does not flip the gesture. */
  readonly ctrlKey: boolean;
  /** True when Meta (Cmd on macOS, Win on Windows) is held. */
  readonly metaKey: boolean;
  /** True when Shift is held. The documented escape hatch. */
  readonly shiftKey: boolean;
}

export const CONTEXT_MENU_FORWARD_HINT =
  'Shift+right-click forwards to the active TUI.';

export function decideContextMenuGesture(
  event: ContextMenuGestureInput,
): ContextMenuGestureKind {
  if (event.button === 2 && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    return 'forward-to-tui';
  }
  return 'show-menu';
}