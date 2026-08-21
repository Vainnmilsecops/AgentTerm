import { describe, expect, it, vi } from 'vitest';

import type {
  TerminalConnectionFailure,
  TerminalController,
  TerminalPasteOutcome,
  TerminalPasteRequest,
} from './terminal-controller';
import {
  dispatchConfirmPaste,
  dispatchPasteText,
  failureToFeedback,
  handleKeyEvent,
} from './terminal-input-glue';

class FakeController {
  public readonly pasteText = vi.fn((_input: TerminalPasteRequest): TerminalPasteOutcome => ({
    failure: undefined,
    status: 'accepted',
  }));
  public readonly sendBytes = vi.fn();
}

describe('dispatchPasteText', () => {
  it('routes small single-line text straight to controller.pasteText', () => {
    const controller = new FakeController();
    const result = dispatchPasteText('hello', {
      controller: controller as unknown as TerminalController,
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    expect(result.pending).toBeUndefined();
    expect(result.feedback.level).toBe('info');
  });

  it('defers large text to confirmation', () => {
    const controller = new FakeController();
    const text = 'x'.repeat(9000);
    const result = dispatchPasteText(text, {
      controller: controller as unknown as TerminalController,
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    expect(result.pending?.byteLength).toBe(9000);
    expect(controller.pasteText).not.toHaveBeenCalled();
  });

  it('rejects paste over 1 MiB', () => {
    const controller = new FakeController();
    const result = dispatchPasteText('x'.repeat(1_048_577), {
      controller: controller as unknown as TerminalController,
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    expect(result.pending).toBeUndefined();
    expect(result.feedback.level).toBe('error');
    expect(result.feedback.message).toContain('1 MiB');
  });

  it('defers multi-line text even at small byte counts', () => {
    const controller = new FakeController();
    const result = dispatchPasteText('a\nb\nc', {
      controller: controller as unknown as TerminalController,
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    expect(result.pending?.lineCount).toBe(3);
  });

  it('reports paste-unavailable when the controller is not connected', () => {
    const controller = new FakeController();
    controller.pasteText.mockImplementationOnce(() => ({
      failure: undefined,
      status: 'paste-unavailable' as const,
    }));
    const result = dispatchPasteText('hello', {
      controller: controller as unknown as TerminalController,
      sessionId: 'session-1',
      taskId: 'task-1',
    });
    expect(result.feedback.level).toBe('error');
    expect(result.feedback.message).toContain('unavailable');
  });
});

describe('dispatchConfirmPaste', () => {
  it('sends the buffered text via pasteText', () => {
    const controller = new FakeController();
    const pending = {
      byteLength: 9000,
      byteLengthLabel: '8.8 KiB',
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(9000),
    };
    const feedback = dispatchConfirmPaste(pending, controller as unknown as TerminalController);
    expect(controller.pasteText).toHaveBeenCalledWith({
      byteLength: 9000,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(9000),
    });
    expect(feedback.level).toBe('info');
  });

  it('reports failure when controller rejects', () => {
    const controller = new FakeController();
    controller.pasteText.mockImplementationOnce(() => ({
      failure: undefined,
      status: 'paste-unavailable' as const,
    }));
    const feedback = dispatchConfirmPaste(
      {
        byteLength: 9000,
        byteLengthLabel: '8.8 KiB',
        lineCount: 1,
        sessionId: 'session-1',
        taskId: 'task-1',
        text: 'x'.repeat(9000),
      },
      controller as unknown as TerminalController,
    );
    expect(feedback.level).toBe('error');
  });
});

describe('handleKeyEvent', () => {
  it('returns false and sends ETX when Ctrl+C is pressed without selection', () => {
    const controller = new FakeController();
    const consumed = handleKeyEvent(
      { ctrlKey: true, isComposing: false, key: 'C', keyCode: 0, metaKey: false, shiftKey: false },
      {
        controller: controller as unknown as TerminalController,
        getSelection: () => '',
        hasSelection: () => false,
        onCopy: () => undefined,
        onPasteFromClipboard: () => Promise.resolve(''),
      },
    );
    expect(consumed).toBe(false);
    expect(controller.sendBytes).toHaveBeenCalledWith('\u0003');
  });

  it('returns false and copies when Ctrl+C is pressed with selection', () => {
    const controller = new FakeController();
    const onCopy = vi.fn((text: string): void | Promise<void> => { void text; });
    const consumed = handleKeyEvent(
      { ctrlKey: true, isComposing: false, key: 'C', keyCode: 0, metaKey: false, shiftKey: false },
      {
        controller: controller as unknown as TerminalController,
        getSelection: () => 'hello',
        hasSelection: () => true,
        onCopy,
        onPasteFromClipboard: () => Promise.resolve(''),
      },
    );
    expect(consumed).toBe(false);
    expect(onCopy).toHaveBeenCalledWith('hello');
    expect(controller.sendBytes).not.toHaveBeenCalled();
  });

  it('returns true and ignores when IME is composing', () => {
    const controller = new FakeController();
    const consumed = handleKeyEvent(
      { ctrlKey: true, isComposing: true, key: 'C', keyCode: 0, metaKey: false, shiftKey: false },
      {
        controller: controller as unknown as TerminalController,
        getSelection: () => '',
        hasSelection: () => false,
        onCopy: () => undefined,
        onPasteFromClipboard: () => Promise.resolve(''),
      },
    );
    expect(consumed).toBe(true);
    expect(controller.sendBytes).not.toHaveBeenCalled();
  });
});

describe('failureToFeedback', () => {
  it('maps paste failures to Paste failed', () => {
    const failure: TerminalConnectionFailure = { operation: 'paste', sessionId: 'session-1' };
    const feedback = failureToFeedback(failure);
    expect(feedback.message).toContain('Paste failed');
  });

  it('maps write failures to Terminal input unavailable', () => {
    const failure: TerminalConnectionFailure = { operation: 'write', sessionId: 'session-1' };
    const feedback = failureToFeedback(failure);
    expect(feedback.message).toContain('Terminal input unavailable');
  });
});
