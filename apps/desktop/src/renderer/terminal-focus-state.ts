/**
 * Pure decision table for restoring a terminal pane's focus, layout, and
 * pending-paste state on tab activation or agent session reattachment.
 *
 * This module is intentionally renderer-only and side-effect-free so it can
 * be unit tested without xterm, the DOM, or the Application layer. The
 * renderer is responsible for invoking the returned actions on the active
 * {@link TerminalController} exactly once per transition.
 */

export interface FocusRestoreContext {
  /**
    * Whether the underlying `TerminalController` is currently attached to a live
    * Agent Session and ready to receive input/output. A controller that is
    * still `attaching`, `exited`, or `failed` should not be re-focused.
    */
  readonly controllerReady: boolean;
  /** Whether a `PendingPasteConfirmation` is currently held by the renderer. */
  readonly hasPendingPaste: boolean;
  /** Whether the previous render had a `PendingPasteConfirmation`. */
  readonly hadPendingPaste: boolean;
  /** The focused pane id on the previous render. */
  readonly previousFocusedPaneId: string | undefined;
  /** The currently focused pane id. */
  readonly currentFocusedPaneId: string | undefined;
  /** The active tab id on the previous render. */
  readonly previousActiveTabId: string | undefined;
  /** The currently active tab id. */
  readonly currentActiveTabId: string | undefined;
  /**
    * Whether the underlying agent session attachment just transitioned from
    * absent to present (a reattach, not a steady-state activation).
    */
  readonly sessionReattached: boolean;
}

export interface FocusRestoreDecision {
  /** Drops any `PendingPasteConfirmation`; the user must re-paste intentionally. */
  readonly clearPendingPaste: boolean;
  /** Recompute the underlying xterm fit addon dimensions before reading input. */
  readonly refit: boolean;
  /** Move DOM focus to the terminal surface's underlying textarea. */
  readonly reassertFocus: boolean;
}

/**
 * Decide which focus-restoration actions to take. The function is pure: same
 * input always produces the same output. Callers must call exactly one action
 * per truthy field, and must avoid calling the action when the field is
 * false.
 *
 * Rules:
 * - `reassertFocus` is true when the active tab or focused pane changed and
 *   the controller is ready to receive input.
 * - `refit` is true whenever a focus-restoration pass runs (so hidden panes
 *   that just became visible recompute their grid).
 * - `clearPendingPaste` is true only on a session reattach with a held
 *   pending paste (the previous text is no longer safe to send into a
 *   possibly-new session).
 */
export function decideFocusRestore(input: FocusRestoreContext): FocusRestoreDecision {
  const activeTabChanged =
    input.previousActiveTabId !== input.currentActiveTabId &&
    input.currentActiveTabId !== undefined;
  const focusedPaneChanged = input.previousFocusedPaneId !== input.currentFocusedPaneId;
  const hasAnyChange = activeTabChanged || focusedPaneChanged;
  const reassertFocus = hasAnyChange && input.controllerReady;

  const refit = hasAnyChange || input.sessionReattached;

  const clearPendingPaste =
    input.sessionReattached && input.hasPendingPaste && !input.hadPendingPaste
      ? true
      : input.sessionReattached && input.hasPendingPaste;

  return {
    clearPendingPaste,
    refit,
    reassertFocus,
  };
}