/**
 * Paste decision logic for the terminal surface.
 *
 * Pure and side-effect-free so it can be unit tested without a DOM or xterm.
 * The render layer is responsible for calling `terminal.paste(text)` once the
 * decision resolves to `accept` or the user confirms `confirm`.
 */

/** Bytes above which the user must explicitly confirm the paste. */
export const PASTE_CONFIRM_BYTES = 8 * 1024;

/** Bytes above which the paste is rejected outright. */
export const PAUSE_BREAK_BYTES = 1 * 1024 * 1024;

/** Bracketed-paste begin marker (ESC[200~) and end marker (ESC[201~). */
export const BRACKETED_PASTE_BEGIN = '\u001b[200~';
export const BRACKETED_PASTE_END = '\u001b[201~';

export type BracketedPasteWrap = 'always' | 'never' | 'auto';

export interface BracketedPasteWrapInput {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly mode: BracketedPasteWrap;
}

export interface PasteClassifier {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly text: string;
}

export interface PasteEvaluationInput {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly sessionId: string;
  readonly taskId: string;
  readonly text: string;
}

export type PasteEvaluation =
  | { readonly kind: 'accept' }
  | {
      readonly byteLength: number;
      readonly kind: 'confirm';
      readonly lineCount: number;
      readonly sessionId: string;
      readonly taskId: string;
    }
  | { readonly kind: 'rejected'; readonly reason: 'TOO_LARGE' };

export function classifyPaste(text: string): PasteClassifier {
  const byteLength = new TextEncoder().encode(text).length;
  // Normalize CRLF to LF so line counts reflect user intent.
  const normalized = text.replace(/\r\n/gu, '\n');
  const lineCount = normalized.length === 0 ? 1 : normalized.split('\n').length;
  return Object.freeze({ byteLength, lineCount, text });
}

export function evaluatePaste(input: PasteEvaluationInput): PasteEvaluation {
  if (input.byteLength >= PAUSE_BREAK_BYTES) {
    return { kind: 'rejected', reason: 'TOO_LARGE' };
  }
  const needsConfirm = input.byteLength > PASTE_CONFIRM_BYTES || input.lineCount > 1;
  if (needsConfirm) {
    return {
      byteLength: input.byteLength,
      kind: 'confirm',
      lineCount: input.lineCount,
      sessionId: input.sessionId,
      taskId: input.taskId,
    };
  }
  return { kind: 'accept' };
}

export function formatPasteByteLength(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Wrap a paste payload in the standard bracketed-paste markers. Pure and
 * side-effect-free so renderer tests can assert exact byte sequences without
 * instantiating xterm. The payload bytes are passed through verbatim.
 */
export function wrapBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_BEGIN}${text}${BRACKETED_PASTE_END}`;
}

/**
 * Decide whether a paste should be wrapped in bracketed-paste markers. The
 * default `auto` wraps multi-line pastes (the common reason agents mishandle
 * paste); single-line, small pastes stay unbracketed to match every popular
 * terminal emulator's default.
 */
export function shouldWrapBracketedPaste(input: BracketedPasteWrapInput): boolean {
  if (input.mode === 'always') return true;
  if (input.mode === 'never') return false;
  return input.lineCount > 1 || input.byteLength > PASTE_CONFIRM_BYTES;
}

/**
 * Convenience helper that combines the wrap decision with the actual payload.
 * Returns the original `text` when wrapping is not requested.
 */
export function prepareBracketedPasteText(
  text: string,
  mode: BracketedPasteWrap,
  lineCount: number,
  byteLength: number,
): string {
  if (!shouldWrapBracketedPaste({ byteLength, lineCount, mode })) return text;
  return wrapBracketedPaste(text);
}
