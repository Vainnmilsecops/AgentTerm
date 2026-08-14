import { describe, expect, it } from 'vitest';

import { mnemonicFor } from './mnemonic-hints';

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
