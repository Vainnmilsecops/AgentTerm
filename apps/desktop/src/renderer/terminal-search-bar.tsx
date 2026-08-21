import { forwardRef, useCallback, useImperativeHandle, useRef, type ChangeEvent, type KeyboardEvent } from 'react';

import type {
  SearchEffectOrEmpty,
  SearchMode,
  SearchResult,
  SearchState,
} from './terminal-search-state';

export interface TerminalSearchBarHandle {
  focus(): void;
}

export interface TerminalSearchBarProps {
  readonly caseSensitive: boolean;
  readonly mode: SearchMode;
  readonly result: SearchResult;
  readonly term: string;
  readonly onCaseChange: (next: boolean) => void;
  readonly onClose: () => void;
  readonly onModeChange: (next: SearchMode) => void;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onTermChange: (next: string) => void;
}

/**
 * Docked overlay that lets the user search inside an xterm buffer. Rendered
 * absolutely on top of the terminal viewport; receives its state and effects
 * from the parent `TerminalRenderer` so the React tree stays the single
 * source of truth for visibility and term changes.
 */
export const TerminalSearchBar = forwardRef<TerminalSearchBarHandle, TerminalSearchBarProps>(
  function TerminalSearchBar(props, ref) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    useImperativeHandle(
      ref,
      (): TerminalSearchBarHandle => ({
        focus: () => inputRef.current?.focus(),
      }),
      [],
    );

    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) {
            props.onPrevious();
          } else {
            props.onNext();
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          props.onClose();
        }
      },
      [props.onClose, props.onNext, props.onPrevious],
    );

    const handleTermInput = useCallback(
      (event: ChangeEvent<HTMLInputElement>): void => {
        props.onTermChange(event.target.value);
      },
      [props.onTermChange],
    );

    const handleModeClick = useCallback((): void => {
      props.onModeChange(props.mode === 'literal' ? 'regex' : 'literal');
    }, [props.mode, props.onModeChange]);

    const handleCaseClick = useCallback((): void => {
      props.onCaseChange(!props.caseSensitive);
    }, [props.caseSensitive, props.onCaseChange]);

    return (
      <div className="terminal-search-bar" role="search">
        <input
          aria-label="Search terminal output"
          className="terminal-search-bar__input"
          data-search-input="true"
          onChange={handleTermInput}
          onKeyDown={handleKeyDown}
          placeholder="Search"
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={props.term}
        />
        <button
          aria-pressed={props.mode === 'regex'}
          className="terminal-search-bar__toggle"
          data-search-mode="toggle"
          onClick={handleModeClick}
          title={props.mode === 'regex' ? 'Regex mode (click for literal)' : 'Literal mode (click for regex)'}
          type="button"
        >
          .*
        </button>
        <button
          aria-pressed={props.caseSensitive}
          className="terminal-search-bar__toggle"
          data-search-case="toggle"
          onClick={handleCaseClick}
          title={props.caseSensitive ? 'Case sensitive (click to ignore case)' : 'Case insensitive (click to match case)'}
          type="button"
        >
          Aa
        </button>
        <SearchResultBadge result={props.result} />
        <button
          aria-label="Previous match"
          className="terminal-search-bar__action"
          data-search-previous="true"
          disabled={!canSearch(props.term)}
          onClick={props.onPrevious}
          title="Previous (Shift+Enter)"
          type="button"
        >
          ↑
        </button>
        <button
          aria-label="Next match"
          className="terminal-search-bar__action"
          data-search-next="true"
          disabled={!canSearch(props.term)}
          onClick={props.onNext}
          title="Next (Enter)"
          type="button"
        >
          ↓
        </button>
        <button
          aria-label="Close search"
          className="terminal-search-bar__action"
          data-search-close="true"
          onClick={props.onClose}
          title="Close (Escape)"
          type="button"
        >
          ×
        </button>
      </div>
    );
  },
);

function canSearch(term: string): boolean {
  return term.trim().length > 0;
}

function SearchResultBadge({ result }: { readonly result: SearchResult }) {
  const label = describeResult(result);
  return (
    <span
      aria-live="polite"
      className={badgeClass(result)}
      data-search-feedback="true"
    >
      {label}
    </span>
  );
}

function describeResult(result: SearchResult): string {
  if (result.kind === 'idle') return '';
  if (result.kind === 'found') return 'Match';
  if (result.kind === 'not-found') return 'No matches';
  return 'Invalid regex';
}

function badgeClass(result: SearchResult): string {
  const base = 'terminal-search-bar__feedback';
  if (result.kind === 'invalid-regex') return `${base} ${base}--error`;
  if (result.kind === 'not-found') return `${base} ${base}--warn`;
  return base;
}

/**
 * Pure helper exposed for the test suite. Returns the imperative effects
 * that the renderer should execute after dispatching an event.
 */
export function executeEffects(
  effects: ReadonlyArray<SearchEffectOrEmpty>,
  handle: TerminalSearchBarHandle | undefined,
): void {
  for (const effect of effects) {
    if (effect.kind === 'focus-input') {
      handle?.focus();
    }
  }
}

/**
 * Decide whether a `KeyboardEvent` should be interpreted as the search
 * shortcut. We accept only `Ctrl+Shift+F` (case insensitive on the letter)
 * to keep the chord stable across keyboard layouts; both `F` and `f`
 * normalise via `key.toLowerCase()` upstream of this call site.
 */
export function isSearchOpenShortcut(event: { readonly ctrlKey: boolean; readonly key: string; readonly metaKey: boolean; readonly shiftKey: boolean }): boolean {
  if (!event.ctrlKey || event.metaKey || !event.shiftKey) return false;
  return event.key.toLowerCase() === 'f';
}

export function deriveSearchView(state: SearchState): {
  readonly caseSensitive: boolean;
  readonly mode: SearchMode;
  readonly result: SearchResult;
  readonly term: string;
} {
  return {
    caseSensitive: state.caseSensitive,
    mode: state.mode,
    result: state.lastResult,
    term: state.term,
  };
}