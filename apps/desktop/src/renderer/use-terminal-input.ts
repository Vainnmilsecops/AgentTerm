import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  TerminalConnectionFailure,
  TerminalController,
} from './terminal-controller';
import {
  decideFocusRestore,
  type FocusRestoreContext,
  type FocusRestoreDecision,
} from './terminal-focus-state';
import {
  dispatchConfirmPaste,
  dispatchPasteText,
  failureToFeedback,
  handleKeyEvent,
  type HandleKeyEventArgs,
  type HandleKeyEventInput,
  type PendingPasteConfirmation,
  type TerminalInputFeedback,
} from './terminal-input-glue';

export interface UseTerminalInputParams {
  readonly active: boolean;
  readonly controller: TerminalController | undefined;
  readonly paneId: string;
  readonly sessionId: string | undefined;
  readonly taskId: string | undefined;
}

export interface UseTerminalInputResult {
  readonly confirmPaste: (pending: PendingPasteConfirmation) => void;
  readonly feedback: TerminalInputFeedback | undefined;
  readonly pasteText: (text: string) => void;
  readonly pendingConfirmation: PendingPasteConfirmation | undefined;
  readonly readClipboard: () => Promise<string>;
  readonly rejectPaste: () => void;
  readonly resetFeedback: () => void;
  readonly showFeedback: (feedback: TerminalInputFeedback) => void;
  readonly tryHandleKeyEvent: (event: KeyboardEvent) => boolean;
  readonly triggerControllerFailure: (failure: TerminalConnectionFailure) => void;
}

export function useTerminalInput(params: UseTerminalInputParams): UseTerminalInputResult {
  const [pendingConfirmation, setPendingConfirmation] = useState<
    PendingPasteConfirmation | undefined
  >(undefined);
  const [feedback, setFeedback] = useState<TerminalInputFeedback | undefined>(undefined);
  const previousSessionIdRef = useRef<string | undefined>(params.sessionId);
  const previousActiveRef = useRef<boolean>(params.active);
  const previousPaneIdRef = useRef<string>(params.paneId);

  const showFeedback = useCallback(
    (next: TerminalInputFeedback): void => setFeedback(next),
    [],
  );
  const resetFeedback = useCallback(() => setFeedback(undefined), []);

  const pasteText = useCallback(
    (text: string): void => {
      if (params.sessionId === undefined || params.taskId === undefined) return;
      const result = dispatchPasteText(text, {
        controller: params.controller,
        sessionId: params.sessionId,
        taskId: params.taskId,
      });
      if (result.pending !== undefined) {
        setPendingConfirmation(result.pending);
      } else {
        setPendingConfirmation(undefined);
      }
      setFeedback(result.feedback);
    },
    [params.controller, params.sessionId, params.taskId],
  );

  const readClipboard = useCallback(async (): Promise<string> => {
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      throw new Error('Clipboard API unavailable');
    }
    return navigator.clipboard.readText();
  }, []);

  const confirmPaste = useCallback(
    (pending: PendingPasteConfirmation): void => {
      setPendingConfirmation(undefined);
      const next = dispatchConfirmPaste(pending, params.controller);
      setFeedback(next);
    },
    [params.controller],
  );

  const rejectPaste = useCallback(() => {
    setPendingConfirmation(undefined);
    setFeedback({ level: 'info', message: 'Paste cancelled.' });
  }, []);

  const triggerControllerFailure = useCallback((failure: TerminalConnectionFailure) => {
    setFeedback(failureToFeedback(failure));
  }, []);

  const tryHandleKeyEvent = useCallback(
    (event: KeyboardEvent): boolean => {
      const wrapSelection = (): string => {
        try {
          const surface = params.controller as unknown as {
            getSelection?: () => string;
          };
          if (surface?.getSelection !== undefined) return surface.getSelection();
        } catch {
          return '';
        }
        return '';
      };
      const wrapHasSelection = (): boolean => wrapSelection().length > 0;
      const args: HandleKeyEventArgs = {
        ctrlKey: event.ctrlKey,
        isComposing: event.isComposing,
        key: event.key,
        keyCode: event.keyCode,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      };
      const ctx: HandleKeyEventInput = {
        controller: params.controller,
        getSelection: wrapSelection,
        hasSelection: wrapHasSelection,
        onCopy: async (text) => {
          if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
          await navigator.clipboard.writeText(text);
        },
        onPasteFromClipboard: () => readClipboard().then((text) => { pasteText(text); return text; }),
      };
      return handleKeyEvent(args, ctx);
    },
    [params.controller, pasteText, readClipboard],
  );

  // Focus + key dispatch restoration: react to active tab/pane transitions
  // and session reattachment. Idempotent: every effect iteration computes a
  // pure decision and dispatches at most one call per truthy field.
  useEffect(() => {
    if (!params.active) {
      previousActiveRef.current = params.active;
      previousPaneIdRef.current = params.paneId;
      previousSessionIdRef.current = params.sessionId;
      return;
    }
    const sessionReattached =
      previousSessionIdRef.current !== params.sessionId &&
      previousSessionIdRef.current !== undefined &&
      params.sessionId !== undefined;
    const ctx: FocusRestoreContext = {
      controllerReady: params.controller !== undefined,
      currentActiveTabId: params.active ? 'active' : undefined,
      currentFocusedPaneId: params.paneId,
      hadPendingPaste: previousActiveRef.current === false,
      hasPendingPaste: pendingConfirmation !== undefined,
      previousActiveTabId: previousActiveRef.current ? 'active' : undefined,
      previousFocusedPaneId: previousPaneIdRef.current,
      sessionReattached,
    };
    const decision: FocusRestoreDecision = decideFocusRestore(ctx);
    if (decision.refit) params.controller?.refit();
    if (decision.reassertFocus) params.controller?.reassertFocus();
    if (decision.clearPendingPaste) {
      setPendingConfirmation(undefined);
      params.controller?.clearPendingPaste();
    }
    previousActiveRef.current = params.active;
    previousPaneIdRef.current = params.paneId;
    previousSessionIdRef.current = params.sessionId;
  }, [
    params.active,
    params.controller,
    params.paneId,
    params.sessionId,
    pendingConfirmation,
  ]);

  return {
    confirmPaste,
    feedback,
    pasteText,
    pendingConfirmation,
    readClipboard,
    rejectPaste,
    resetFeedback,
    showFeedback,
    tryHandleKeyEvent,
    triggerControllerFailure,
  };
}
