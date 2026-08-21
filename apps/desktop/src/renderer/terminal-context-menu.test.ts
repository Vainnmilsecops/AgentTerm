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
      kind: 'copy',
    });
    expect(action.kind).toBe('copy');
    expect(action.enabled).toBe(true);
  });

  it('Copy is disabled when selection is empty', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      kind: 'copy',
    });
    expect(action.kind).toBe('copy');
    expect(action.enabled).toBe(false);
  });

  it('Paste is always enabled when invoked from the menu', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      kind: 'paste',
    });
    expect(action.kind).toBe('paste');
    expect(action.enabled).toBe(true);
  });

  it('Select all is always enabled', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      kind: 'select-all',
    });
    expect(action.kind).toBe('select-all');
    expect(action.enabled).toBe(true);
  });

  it('Stop Agent is always enabled when session is attached', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      kind: 'agent-stop',
    });
    expect(action.kind).toBe('agent-stop');
    expect(action.enabled).toBe(true);
  });

  it('Send Signal is always enabled when session is attached', () => {
    const action = decideContextMenuAction({
      hasSelection: false,
      kind: 'agent-signal',
    });
    expect(action.kind).toBe('agent-signal');
    expect(action.enabled).toBe(true);
  });
});

describe('buildContextMenuActions', () => {
  it('produces exactly three terminal actions when no session is attached', () => {
    const actions = buildContextMenuActions(undefined, false);
    expect(actions.map((a) => a.kind)).toEqual(['copy', 'paste', 'select-all']);
  });

  it('disables Copy when there is no selection', () => {
    const actions = buildContextMenuActions(undefined, false);
    const copy = actions.find((a) => a.kind === 'copy');
    expect(copy?.enabled).toBe(false);
  });

  it('enables Copy when there is a selection', () => {
    const actions = buildContextMenuActions(undefined, true);
    const copy = actions.find((a) => a.kind === 'copy');
    expect(copy?.enabled).toBe(true);
  });

  it('adds Stop Agent and Send Signal when a session is attached', () => {
    const actions = buildContextMenuActions('session-1', true);
    expect(actions.map((a) => a.kind)).toEqual([
      'copy',
      'paste',
      'select-all',
      'agent-stop',
      'agent-signal',
    ]);
  });

  it('Stop Agent and Send Signal have section label', () => {
    const actions = buildContextMenuActions('session-1', true);
    const stop = actions.find((a) => a.kind === 'agent-stop');
    const signal = actions.find((a) => a.kind === 'agent-signal');
    expect(stop?.section).toBe('Agent Session');
    expect(signal?.section).toBe('Agent Session');
  });

  it('returns 5 actions with correct labels', () => {
    const actions = buildContextMenuActions('session-1', true);
    expect(actions.map((a) => a.label)).toEqual([
      'Copy',
      'Paste',
      'Select all',
      'Stop Agent',
      'Send Signal (Ctrl+C)',
    ]);
  });
});
