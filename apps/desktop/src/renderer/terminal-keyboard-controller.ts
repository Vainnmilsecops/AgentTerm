/**
 * Pure decision table for terminal keyboard/menu events.
 *
 * This module is intentionally renderer-only and side-effect-free so it can be
 * unit tested without xterm, the DOM, or the Application layer. Wiring into
 * `attachCustomKeyEventHandler` and the context menu lives in the consuming
 * components.
 */

export interface KeyboardEventLike {
  /** True when the IME composition is in progress. */
  readonly composing: boolean;
  readonly ctrlKey: boolean;
  /** Unmodified logical key. Must be normalized to ASCII for letter keys. */
  readonly key: string;
  /** keyCode 229 is the historical "composition in progress" marker (Windows/Chromium). */
  readonly keyCode?: number;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface Modifier {
  readonly ctrl: boolean;
  readonly meta: boolean;
}

export interface TerminalKeyContext {
  /** Whether the terminal currently has a non-empty selection. */
  readonly hasSelection: boolean;
}

export type TerminalKeyOutcome =
  | 'COPY'
  | 'IGNORE'
  | 'PASTE'
  | 'SEND_BYTES';

export interface TerminalKeyDecision {
  readonly outcome: TerminalKeyOutcome;
  /** When outcome is SEND_BYTES, the bytes to send via PTY. */
  readonly bytes?: string;
  /** When outcome is COPY or PASTE, the clipboard flavor handled. */
  readonly flavor?: 'clipboard' | 'selection';
}

const ETX = '\u0003';

function isModifierActive(event: KeyboardEventLike): boolean {
  return event.ctrlKey || event.metaKey;
}

function isComposing(event: KeyboardEventLike): boolean {
  if (event.composing) return true;
  if (event.key === 'Process') return true;
  if (event.keyCode === 229) return true;
  return false;
}

function normalizeKey(key: string): string {
  if (key.length === 1) {
    return key.toUpperCase();
  }
  return key.toUpperCase();
}

export function decideKeyOutcome(
  event: KeyboardEventLike,
  context: TerminalKeyContext,
): TerminalKeyOutcome {
  if (isComposing(event)) return 'IGNORE';
  const key = normalizeKey(event.key);

  if (key === 'C' && isModifierActive(event) && !event.shiftKey) {
    return context.hasSelection ? 'COPY' : 'SEND_BYTES';
  }
  if (key === 'C' && isModifierActive(event) && event.shiftKey) {
    return 'COPY';
  }
  if (key === 'V' && isModifierActive(event)) {
    return 'PASTE';
  }
  if (key === 'INSERT' && event.ctrlKey) {
    return event.shiftKey ? 'PASTE' : 'COPY';
  }
  return 'IGNORE';
}

export function buildDecision(
  event: KeyboardEventLike,
  context: TerminalKeyContext,
): TerminalKeyDecision {
  const outcome = decideKeyOutcome(event, context);
  if (outcome === 'COPY') return { flavor: 'clipboard', outcome };
  if (outcome === 'PASTE') return { flavor: 'clipboard', outcome };
  if (outcome === 'SEND_BYTES') return { bytes: ETX, outcome };
  return { outcome };
}

export const ETX_BYTE = ETX;
