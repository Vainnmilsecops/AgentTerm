import { describe, expect, it } from 'vitest';

import { decideFocusRestore, type FocusRestoreContext } from './terminal-focus-state';

function baseContext(overrides: Partial<FocusRestoreContext> = {}): FocusRestoreContext {
  return {
    controllerReady: true,
    currentActiveTabId: 'tab-1',
    currentFocusedPaneId: 'pane-1',
    hadPendingPaste: false,
    hasPendingPaste: false,
    previousActiveTabId: 'tab-1',
    previousFocusedPaneId: 'pane-1',
    sessionReattached: false,
    ...overrides,
  };
}

describe('decideFocusRestore', () => {
  it('returns no actions when nothing changed and session is steady', () => {
    const decision = decideFocusRestore(baseContext());
    expect(decision).toEqual({
      clearPendingPaste: false,
      refit: false,
      reassertFocus: false,
    });
  });

  it('reasserts focus and refits when the active tab changes', () => {
    const decision = decideFocusRestore(
      baseContext({ previousActiveTabId: 'tab-0' }),
    );
    expect(decision.reassertFocus).toBe(true);
    expect(decision.refit).toBe(true);
    expect(decision.clearPendingPaste).toBe(false);
  });

  it('reasserts focus and refits when only the focused pane changes', () => {
    const decision = decideFocusRestore(
      baseContext({ currentFocusedPaneId: 'pane-2', previousFocusedPaneId: 'pane-1' }),
    );
    expect(decision.reassertFocus).toBe(true);
    expect(decision.refit).toBe(true);
  });

  it('does not reassert focus when the controller is not ready', () => {
    const decision = decideFocusRestore(
      baseContext({
        controllerReady: false,
        previousActiveTabId: 'tab-0',
      }),
    );
    expect(decision.reassertFocus).toBe(false);
    expect(decision.refit).toBe(true);
  });

  it('still refits on a session reattach even when the active tab is unchanged', () => {
    const decision = decideFocusRestore(baseContext({ sessionReattached: true }));
    expect(decision.refit).toBe(true);
    expect(decision.reassertFocus).toBe(false);
  });

  it('clears a held pending paste only on a reattach', () => {
    const reattach = decideFocusRestore(
      baseContext({ hasPendingPaste: true, sessionReattached: true }),
    );
    expect(reattach.clearPendingPaste).toBe(true);

    const noChange = decideFocusRestore(
      baseContext({ hasPendingPaste: true, sessionReattached: false }),
    );
    expect(noChange.clearPendingPaste).toBe(false);

    const tabOnly = decideFocusRestore(
      baseContext({
        hasPendingPaste: true,
        previousActiveTabId: 'tab-0',
      }),
    );
    expect(tabOnly.clearPendingPaste).toBe(false);
  });

  it('does not act when the controller is absent on a reattach', () => {
    const decision = decideFocusRestore(
      baseContext({
        controllerReady: false,
        hasPendingPaste: true,
        sessionReattached: true,
      }),
    );
    expect(decision.reassertFocus).toBe(false);
    expect(decision.refit).toBe(true);
    expect(decision.clearPendingPaste).toBe(true);
  });

  it('treats a transition from undefined previous tab as a tab change', () => {
    const decision = decideFocusRestore(
      baseContext({ previousActiveTabId: undefined }),
    );
    expect(decision.reassertFocus).toBe(true);
    expect(decision.refit).toBe(true);
  });

  it('is pure: same input yields the same output', () => {
    const ctx = baseContext({ previousActiveTabId: 'tab-0' });
    const a = decideFocusRestore(ctx);
    const b = decideFocusRestore(ctx);
    expect(a).toEqual(b);
  });
});