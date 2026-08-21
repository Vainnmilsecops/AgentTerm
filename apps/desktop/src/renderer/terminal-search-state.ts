/**
 * Pure state machine for the in-terminal search bar. Owns the search
 * term, mode (literal vs regex), case-sensitivity toggle, and the
 * imperative effects the React layer must execute (`focusInput`,
 * `clearDecorations`). No DOM, no xterm, no React — testable in
 * isolation.
 */

export type SearchMode = 'literal' | 'regex';
export type SearchFeedbackLevel = 'info' | 'warn';

export interface SearchOptions {
  readonly caseSensitive: boolean;
  readonly mode: SearchMode;
}

export interface SearchState {
  readonly open: boolean;
  readonly term: string;
  readonly mode: SearchMode;
  readonly caseSensitive: boolean;
  readonly lastResult: SearchResult;
}

export type SearchResult =
  | { readonly kind: 'idle' }
  | { readonly kind: 'found' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'invalid-regex'; readonly message: string };

export type SearchEvent =
  | { readonly kind: 'OPEN' }
  | { readonly kind: 'CLOSE' }
  | { readonly kind: 'SET_TERM'; readonly term: string }
  | { readonly kind: 'SET_MODE'; readonly mode: SearchMode }
  | { readonly kind: 'SET_CASE'; readonly caseSensitive: boolean }
  | { readonly kind: 'NEXT' }
  | { readonly kind: 'PREVIOUS' }
  | { readonly kind: 'RECORD_RESULT'; readonly result: SearchResult };

export interface SearchEffect {
  readonly kind: 'focus-input';
}

export type SearchEffectOrEmpty = SearchEffect | { readonly kind: 'none' };

export interface SearchDecision {
  readonly effects: ReadonlyArray<SearchEffectOrEmpty>;
  readonly state: SearchState;
}

const IDLE: SearchResult = { kind: 'idle' };

const CLOSED: SearchState = Object.freeze({
  caseSensitive: false,
  lastResult: IDLE,
  mode: 'literal',
  open: false,
  term: '',
});

export function initialSearchState(): SearchState {
  return CLOSED;
}

export function decideSearchAction(
  state: SearchState,
  event: SearchEvent,
): SearchDecision {
  switch (event.kind) {
    case 'OPEN': {
      const effects: SearchEffectOrEmpty[] = [focusInput()];
      if (state.open) {
        return { effects, state };
      }
      return {
        effects,
        state: Object.freeze({ ...state, open: true }),
      };
    }
    case 'CLOSE': {
      if (!state.open) {
        return { effects: [noneEffect()], state };
      }
      return {
        effects: [noneEffect()],
        state: Object.freeze({ ...state, lastResult: IDLE, open: false }),
      };
    }
    case 'SET_TERM': {
      const next: SearchState = Object.freeze({
        ...state,
        term: event.term,
        lastResult: state.open ? validateResult(event.term, state) : state.lastResult,
      });
      return { effects: [noneEffect()], state: next };
    }
    case 'SET_MODE': {
      const next: SearchState = Object.freeze({
        ...state,
        mode: event.mode,
        lastResult: state.open ? validateResult(state.term, { ...state, mode: event.mode }) : state.lastResult,
      });
      return { effects: [noneEffect()], state: next };
    }
    case 'SET_CASE': {
      const next: SearchState = Object.freeze({
        ...state,
        caseSensitive: event.caseSensitive,
        lastResult: state.open ? validateResult(state.term, { ...state, caseSensitive: event.caseSensitive }) : state.lastResult,
      });
      return { effects: [noneEffect()], state: next };
    }
    case 'NEXT':
    case 'PREVIOUS': {
      if (!state.open) {
        return { effects: [noneEffect()], state };
      }
      return { effects: [noneEffect()], state };
    }
    case 'RECORD_RESULT':
      return {
        effects: [noneEffect()],
        state: Object.freeze({ ...state, lastResult: event.result }),
      };
  }
}

/**
 * Compile the current term into either a literal string or a RegExp.
 * Returns `{ kind: 'invalid-regex', message }` when the term is a
 * non-empty regex that fails to compile.
 */
export function compileSearchTerm(
  term: string,
  options: SearchOptions,
): { kind: 'literal'; value: string } | { kind: 'regex'; value: RegExp } | { kind: 'invalid-regex'; message: string } {
  if (options.mode === 'literal') {
    return { kind: 'literal', value: term };
  }
  if (term.length === 0) {
    return { kind: 'invalid-regex', message: 'Regex pattern is empty.' };
  }
  try {
    const value = new RegExp(
      term,
      options.caseSensitive ? '' : 'i',
    );
    return { kind: 'regex', value };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid regex.';
    return { kind: 'invalid-regex', message };
  }
}

function validateResult(term: string, state: SearchState): SearchResult {
  if (term.length === 0) {
    return IDLE;
  }
  if (state.mode === 'regex') {
    const compiled = compileSearchTerm(term, {
      caseSensitive: state.caseSensitive,
      mode: state.mode,
    });
    if (compiled.kind === 'invalid-regex') {
      return { kind: 'invalid-regex', message: compiled.message };
    }
  }
  // `found` / `not-found` is decided by the addon, not the reducer. The
  // reducer only reports whether the term is well-formed; the React
  // layer invokes the addon and dispatches RECORD_RESULT.
  return IDLE;
}

function focusInput(): SearchEffectOrEmpty {
  return { kind: 'focus-input' };
}

function noneEffect(): SearchEffectOrEmpty {
  return { kind: 'none' };
}