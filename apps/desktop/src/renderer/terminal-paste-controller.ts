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
  if (input.byteLength > PAUSE_BREAK_BYTES) {
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
