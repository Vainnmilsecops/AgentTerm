import type {
  TerminalConnectionFailure,
  TerminalController,
} from './terminal-controller';
import { decideKeyOutcome, ETX_BYTE } from './terminal-keyboard-controller';
import {
  classifyPaste,
  evaluatePaste,
  formatPasteByteLength,
  prepareBracketedPasteText,
  type BracketedPasteWrap,
} from './terminal-paste-controller';

export interface PendingPasteConfirmation {
  readonly byteLength: number;
  readonly byteLengthLabel: string;
  readonly lineCount: number;
  readonly sessionId: string;
  readonly taskId: string;
  readonly text: string;
}

export interface TerminalInputFeedback {
  readonly level: 'error' | 'info';
  readonly message: string;
}

export interface PasteDispatchInput {
  readonly controller: TerminalController | undefined;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface PasteDispatchResult {
  readonly feedback: TerminalInputFeedback;
  readonly pending?: PendingPasteConfirmation;
}

export function dispatchPasteText(text: string, input: PasteDispatchInput): PasteDispatchResult {
  const cls = classifyPaste(text);
  const decision = evaluatePaste({
    byteLength: cls.byteLength,
    lineCount: cls.lineCount,
    sessionId: input.sessionId,
    taskId: input.taskId,
    text,
  });
  if (decision.kind === 'rejected') {
    return {
      feedback: { level: 'error', message: 'Paste rejected — over 1 MiB paste limit.' },
    };
  }
  if (decision.kind === 'confirm') {
    return {
      feedback: { level: 'error', message: 'Large paste — confirm to send.' },
      pending: {
        byteLength: decision.byteLength,
        byteLengthLabel: formatPasteByteLength(decision.byteLength),
        lineCount: decision.lineCount,
        sessionId: decision.sessionId,
        taskId: decision.taskId,
        text,
      },
    };
  }
  const wrapMode: BracketedPasteWrap = 'never';
  const outcome = input.controller?.pasteText({
    byteLength: cls.byteLength,
    lineCount: cls.lineCount,
    sessionId: input.sessionId,
    taskId: input.taskId,
    text: prepareBracketedPasteText(text, wrapMode, cls.lineCount, cls.byteLength),
    wrap: wrapMode,
  });
  if (outcome?.status === 'paste-unavailable') {
    return {
      feedback: {
        level: 'error',
        message: 'Terminal input unavailable — paste could not be sent.',
      },
    };
  }
  return { feedback: { level: 'info', message: 'Pasted text through terminal.paste()' } };
}

export function dispatchConfirmPaste(
  pending: PendingPasteConfirmation,
  controller: TerminalController | undefined,
): TerminalInputFeedback {
  const wrapMode: BracketedPasteWrap = 'auto';
  const outcome = controller?.pasteText({
    byteLength: pending.byteLength,
    lineCount: pending.lineCount,
    sessionId: pending.sessionId,
    taskId: pending.taskId,
    text: prepareBracketedPasteText(
      pending.text,
      wrapMode,
      pending.lineCount,
      pending.byteLength,
    ),
    wrap: wrapMode,
  });
  if (outcome?.status === 'paste-unavailable') {
    return { level: 'error', message: 'Paste failed — terminal input unavailable.' };
  }
  return { level: 'info', message: 'Pasted text through terminal.paste()' };
}

export interface HandleKeyEventInput {
  readonly controller: TerminalController | undefined;
  readonly getSelection: () => string;
  readonly hasSelection: () => boolean;
  readonly onCopy: (text: string) => Promise<void> | void;
  readonly onPasteFromClipboard: () => Promise<string> | string;
}

export interface HandleKeyEventArgs {
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
  readonly key: string;
  readonly keyCode: number;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export function handleKeyEvent(event: HandleKeyEventArgs, ctx: HandleKeyEventInput): boolean {
  const outcome = decideKeyOutcome(
    {
      composing: event.isComposing,
      ctrlKey: event.ctrlKey,
      key: event.key,
      keyCode: event.keyCode,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    },
    { hasSelection: ctx.hasSelection() },
  );
  if (outcome === 'IGNORE') return true;
  if (outcome === 'COPY') {
    const selection = ctx.getSelection();
    if (selection.length > 0) void ctx.onCopy(selection);
    return false;
  }
  if (outcome === 'PASTE') {
    void Promise.resolve(ctx.onPasteFromClipboard());
    return false;
  }
  ctx.controller?.sendBytes(ETX_BYTE);
  return false;
}

export function failureToFeedback(failure: TerminalConnectionFailure): TerminalInputFeedback {
  const message =
    failure.operation === 'paste'
      ? 'Paste failed — terminal input unavailable.'
      : 'Terminal input unavailable.';
  return { level: 'error', message };
}
