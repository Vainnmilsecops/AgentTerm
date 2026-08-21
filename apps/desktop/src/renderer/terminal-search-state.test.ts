import { describe, expect, it } from 'vitest';

import {
  compileSearchTerm,
  decideSearchAction,
  initialSearchState,
  type SearchState,
} from './terminal-search-state';

const IDLE_RESULT = { kind: 'idle' as const };

function openState(overrides: Partial<SearchState> = {}): SearchState {
  return Object.freeze({
    caseSensitive: false,
    lastResult: IDLE_RESULT,
    mode: 'literal',
    open: true,
    term: 'foo',
    ...overrides,
  });
}

describe('decideSearchAction', () => {
  it('opens the bar and requests focus on OPEN', () => {
    const result = decideSearchAction(initialSearchState(), { kind: 'OPEN' });
    expect(result.state.open).toBe(true);
    expect(result.effects).toEqual([{ kind: 'focus-input' }]);
  });

  it('OPEN is idempotent and still requests focus', () => {
    const opened = openState();
    const result = decideSearchAction(opened, { kind: 'OPEN' });
    expect(result.state.open).toBe(true);
    expect(result.state.term).toBe('foo');
    expect(result.effects).toEqual([{ kind: 'focus-input' }]);
  });

  it('CLOSE resets lastResult to idle', () => {
    const result = decideSearchAction(openState({ lastResult: { kind: 'found' } }), {
      kind: 'CLOSE',
    });
    expect(result.state.open).toBe(false);
    expect(result.state.lastResult).toEqual({ kind: 'idle' });
  });

  it('CLOSE is a no-op when already closed', () => {
    const result = decideSearchAction(initialSearchState(), { kind: 'CLOSE' });
    expect(result.state).toBe(initialSearchState());
    expect(result.effects).toEqual([{ kind: 'none' }]);
  });

  it('SET_TERM stores the term and clears lastResult when open', () => {
    const result = decideSearchAction(
      openState({ lastResult: { kind: 'not-found' } }),
      { kind: 'SET_TERM', term: 'bar' },
    );
    expect(result.state.term).toBe('bar');
    expect(result.state.lastResult).toEqual({ kind: 'idle' });
  });

  it('SET_TERM keeps lastResult untouched when closed', () => {
    const result = decideSearchAction(
      initialSearchState(),
      { kind: 'SET_TERM', term: 'bar' },
    );
    expect(result.state.term).toBe('bar');
    expect(result.state.open).toBe(false);
    expect(result.state.lastResult).toEqual({ kind: 'idle' });
  });

  it('SET_MODE switches mode and validates the current term', () => {
    const result = decideSearchAction(openState({ term: '(' }), {
      kind: 'SET_MODE',
      mode: 'regex',
    });
    expect(result.state.mode).toBe('regex');
    expect(result.state.lastResult).toMatchObject({ kind: 'invalid-regex' });
  });

  it('SET_CASE leaves the term intact', () => {
    const result = decideSearchAction(openState({ term: 'Foo' }), {
      kind: 'SET_CASE',
      caseSensitive: true,
    });
    expect(result.state.caseSensitive).toBe(true);
    expect(result.state.term).toBe('Foo');
  });

  it('NEXT/PREVIOUS are no-ops in the reducer', () => {
    const opened = openState();
    expect(decideSearchAction(opened, { kind: 'NEXT' }).state).toEqual(opened);
    expect(decideSearchAction(opened, { kind: 'PREVIOUS' }).state).toEqual(opened);
  });

  it('NEXT/PREVIOUS ignore when closed', () => {
    const result = decideSearchAction(initialSearchState(), { kind: 'NEXT' });
    expect(result.effects).toEqual([{ kind: 'none' }]);
    expect(result.state).toEqual(initialSearchState());
  });

  it('RECORD_RESULT updates lastResult without re-validation', () => {
    const result = decideSearchAction(openState(), {
      kind: 'RECORD_RESULT',
      result: { kind: 'not-found' },
    });
    expect(result.state.lastResult).toEqual({ kind: 'not-found' });
  });
});

describe('compileSearchTerm', () => {
  it('returns the literal string verbatim', () => {
    expect(compileSearchTerm('foo', { caseSensitive: false, mode: 'literal' })).toEqual({
      kind: 'literal',
      value: 'foo',
    });
  });

  it('compiles a valid regex with case-sensitivity flag', () => {
    expect(
      compileSearchTerm('FOO', { caseSensitive: true, mode: 'regex' }),
    ).toEqual({ kind: 'regex', value: /FOO/ });
    expect(
      compileSearchTerm('FOO', { caseSensitive: false, mode: 'regex' }),
    ).toEqual({ kind: 'regex', value: /FOO/i });
  });

  it('reports an invalid regex without throwing', () => {
    expect(compileSearchTerm('(', { caseSensitive: false, mode: 'regex' })).toMatchObject({
      kind: 'invalid-regex',
    });
  });

  it('refuses an empty regex pattern', () => {
    expect(compileSearchTerm('', { caseSensitive: false, mode: 'regex' })).toEqual({
      kind: 'invalid-regex',
      message: 'Regex pattern is empty.',
    });
  });
});