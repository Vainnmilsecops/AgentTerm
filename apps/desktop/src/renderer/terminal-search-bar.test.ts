import { describe, expect, it } from 'vitest';

import {
  decideSearchAction,
  initialSearchState,
} from './terminal-search-state';
import {
  deriveSearchView,
  isSearchOpenShortcut,
} from './terminal-search-bar';

describe('isSearchOpenShortcut', () => {
  it('matches Ctrl+Shift+F', () => {
    expect(
      isSearchOpenShortcut({ ctrlKey: true, key: 'F', metaKey: false, shiftKey: true }),
    ).toBe(true);
  });

  it('normalizes lowercase f', () => {
    expect(
      isSearchOpenShortcut({ ctrlKey: true, key: 'f', metaKey: false, shiftKey: true }),
    ).toBe(true);
  });

  it('rejects Ctrl+F (no shift)', () => {
    expect(
      isSearchOpenShortcut({ ctrlKey: true, key: 'f', metaKey: false, shiftKey: false }),
    ).toBe(false);
  });

  it('rejects Meta+Shift+F (mac chord)', () => {
    expect(
      isSearchOpenShortcut({ ctrlKey: false, key: 'f', metaKey: true, shiftKey: true }),
    ).toBe(false);
  });

  it('rejects Ctrl+Shift+G', () => {
    expect(
      isSearchOpenShortcut({ ctrlKey: true, key: 'g', metaKey: false, shiftKey: true }),
    ).toBe(false);
  });
});

describe('deriveSearchView', () => {
  it('forwards every primitive from the reducer state', () => {
    const opened = decideSearchAction(initialSearchState(), { kind: 'OPEN' });
    const view = deriveSearchView(opened.state);
    expect(view.caseSensitive).toBe(false);
    expect(view.mode).toBe('literal');
    expect(view.term).toBe('');
  });

  it('reflects SET_TERM and SET_CASE', () => {
    let state = decideSearchAction(initialSearchState(), { kind: 'OPEN' }).state;
    state = decideSearchAction(state, { kind: 'SET_TERM', term: 'foo' }).state;
    state = decideSearchAction(state, { kind: 'SET_CASE', caseSensitive: true }).state;
    const view = deriveSearchView(state);
    expect(view.term).toBe('foo');
    expect(view.caseSensitive).toBe(true);
  });
});