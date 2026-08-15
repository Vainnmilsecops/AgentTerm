import { describe, expect, it } from 'vitest';

import { mnemonicFor, resolveWorkspaceMnemonic } from './mnemonic-hints';

describe('mnemonicFor', () => {
  it('returns mnemonic for begin-planning', () => {
    expect(mnemonicFor('begin-planning')).toEqual({
      key: 'P',
      label: 'Begin planning',
      modifiers: ['Alt'],
    });
  });

  it('returns mnemonic for start-task', () => {
    expect(mnemonicFor('start-task')).toEqual({
      key: 'S',
      label: 'Start execution',
      modifiers: ['Alt'],
    });
  });

  it('returns Alt+Shift mnemonic for review actions', () => {
    expect(mnemonicFor('request-review')).toEqual({
      key: 'R',
      label: 'Start review',
      modifiers: ['Alt', 'Shift'],
    });
  });

  it('returns undefined for unknown action', () => {
    expect(mnemonicFor('unknown-action')).toBeUndefined();
  });
});

describe('resolveWorkspaceMnemonic', () => {
  const ready = {
    canAcceptPlan: true,
    canApproveReview: true,
    canBeginPlanning: true,
    canRequestChanges: true,
    canRequestReview: true,
    canRetryExecution: true,
    canStartExecution: true,
    canStartPlanning: true,
    canRevisePlan: false,
  } as const;

  it('chooses the phase-appropriate planning action for Alt+P', () => {
    expect(
      resolveWorkspaceMnemonic(
        { altKey: true, ctrlKey: false, key: 'p', metaKey: false, shiftKey: false },
        ready,
      ),
    ).toBe('begin-planning');
    expect(
      resolveWorkspaceMnemonic(
        { altKey: true, ctrlKey: false, key: 'p', metaKey: false, shiftKey: false },
        { ...ready, canBeginPlanning: false },
      ),
    ).toBe('start-planning');
  });

  it('requires the advertised Shift modifier for review and change actions', () => {
    expect(
      resolveWorkspaceMnemonic(
        { altKey: true, ctrlKey: false, key: 'c', metaKey: false, shiftKey: false },
        ready,
      ),
    ).toBeUndefined();
    expect(
      resolveWorkspaceMnemonic(
        { altKey: true, ctrlKey: false, key: 'C', metaKey: false, shiftKey: true },
        ready,
      ),
    ).toBe('request-changes');
  });

  it('does not intercept IME composition or editable controls', () => {
    const key = { altKey: true, ctrlKey: false, key: 's', metaKey: false, shiftKey: false };
    expect(resolveWorkspaceMnemonic({ ...key, composing: true }, ready)).toBeUndefined();
    expect(resolveWorkspaceMnemonic({ ...key, editable: true }, ready)).toBeUndefined();
  });
});
