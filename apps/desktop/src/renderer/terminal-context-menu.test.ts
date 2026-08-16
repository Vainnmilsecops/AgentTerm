import { describe, expect, it } from 'vitest';

import {
  buildContextMenuActions,
  decideContextMenuAction,
  type ContextMenuAction,
} from './terminal-context-menu';

describe('decideContextMenuAction', () => {
  it('Copy is enabled when selection is non-empty', () => {
    const action: ContextMenuAction = decideContextMenuAction({
      hasSelection: true,
      mode: 'copy',
    });
    expect(action.kind).toBe('copy');
    expect(action.enabled).toBe(true);
  });

  it('Copy is disabled when selection is empty', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      mode: 'copy',
    });
    expect(action.kind).toBe('copy');
    expect(action.enabled).toBe(false);
  });

  it('Paste is always enabled when invoked from the menu', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      mode: 'paste',
    });
    expect(action.kind).toBe('paste');
    expect(action.enabled).toBe(true);
  });

  it('Select all is always enabled', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      mode: 'select-all',
    });
    expect(action.kind).toBe('select-all');
    expect(action.enabled).toBe(true);
  });
});

describe('buildContextMenuActions', () => {
  it('produces exactly three actions in fixed order', () => {
    const actions = buildContextMenuActions('');
    expect(actions.map((a) => a.kind)).toEqual(['copy', 'paste', 'select-all']);
  });

  it('disables Copy when there is no selection', () => {
    const actions = buildContextMenuActions('');
    const copy = actions.find((a) => a.kind === 'copy');
    expect(copy?.enabled).toBe(false);
  });

  it('enables Copy when there is a selection', () => {
    const actions = buildContextMenuActions('hello');
    const copy = actions.find((a) => a.kind === 'copy');
    expect(copy?.enabled).toBe(true);
  });
});
