import { describe, expect, it } from 'vitest';

import {
  BRACKETED_PASTE_BEGIN,
  BRACKETED_PASTE_END,
  classifyPaste,
  evaluatePaste,
  formatPasteByteLength,
  prepareBracketedPasteText,
  PASTE_CONFIRM_BYTES,
  PAUSE_BREAK_BYTES,
  shouldWrapBracketedPaste,
  type PasteClassifier,
  wrapBracketedPaste,
} from './terminal-paste-controller';

describe('evaluatePaste — rejected before sending', () => {
  it('rejects when size exceeds hard limit', () => {
    const result = evaluatePaste({
      byteLength: 1_048_577,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(1_048_577),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('TOO_LARGE');
    }
  });

  it('accepts single-line normal text without confirmation', () => {
    const result = evaluatePaste({
      byteLength: 10,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'hello',
    });
    expect(result.kind).toBe('accept');
  });

  it('requires confirmation for multi-line text even at small byte counts', () => {
    const result = evaluatePaste({
      byteLength: 30,
      lineCount: 4,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'a\nb\nc\nd',
    });
    expect(result.kind).toBe('confirm');
    if (result.kind === 'confirm') {
      expect(result.lineCount).toBe(4);
      expect(result.byteLength).toBe(30);
      expect(result.sessionId).toBe('session-1');
      expect(result.taskId).toBe('task-1');
    }
  });

  it('requires confirmation once byte length crosses confirm threshold', () => {
    const result = evaluatePaste({
      byteLength: PASTE_CONFIRM_BYTES + 1,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(PASTE_CONFIRM_BYTES + 1),
    });
    expect(result.kind).toBe('confirm');
  });

  it('accepts single-line text at the confirm threshold boundary', () => {
    const result = evaluatePaste({
      byteLength: PASTE_CONFIRM_BYTES,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(PASTE_CONFIRM_BYTES),
    });
    expect(result.kind).toBe('accept');
  });

  it('counts UTF-8 byte length, not code points', () => {
    const text = 'Tiếng Việt có dấu 🐍';
    const bytes = new TextEncoder().encode(text).length;
    const result = evaluatePaste({
      byteLength: bytes,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text,
    });
    expect(result.kind).toBe('accept');
  });

  it('treats exactly 1 MiB as too large', () => {
    const result = evaluatePaste({
      byteLength: PAUSE_BREAK_BYTES,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(PAUSE_BREAK_BYTES),
    });
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') {
      expect(result.reason).toBe('TOO_LARGE');
    }
  });

  it('treats just below 1 MiB with multiple lines as requiring confirmation', () => {
    const result = evaluatePaste({
      byteLength: PAUSE_BREAK_BYTES - 1,
      lineCount: 2,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(PAUSE_BREAK_BYTES - 1),
    });
    expect(result.kind).toBe('confirm');
  });
});

describe('classifyPaste — line counting', () => {
  it('counts a single line as 1', () => {
    const cls: PasteClassifier = classifyPaste('hello');
    expect(cls.lineCount).toBe(1);
    expect(cls.byteLength).toBe(5);
  });

  it('counts trailing newline as a separate empty line', () => {
    const cls = classifyPaste('a\nb\n');
    expect(cls.lineCount).toBe(3);
  });

  it('counts CRLF as one line break', () => {
    const cls = classifyPaste('a\r\nb');
    expect(cls.lineCount).toBe(2);
  });

  it('handles multi-byte UTF-8 byte length correctly', () => {
    const text = '🐍🚀';
    const cls = classifyPaste(text);
    expect(cls.byteLength).toBe(new TextEncoder().encode(text).length);
    expect(cls.lineCount).toBe(1);
  });
});

describe('wrapBracketedPaste — pure escape wrapping', () => {
  it('wraps an empty payload with begin and end markers', () => {
    expect(wrapBracketedPaste('')).toBe(`${BRACKETED_PASTE_BEGIN}${BRACKETED_PASTE_END}`);
  });

  it('preserves ASCII payload verbatim between markers', () => {
    expect(wrapBracketedPaste('hi')).toBe(`${BRACKETED_PASTE_BEGIN}hi${BRACKETED_PASTE_END}`);
  });

  it('preserves multi-byte UTF-8 payload verbatim between markers', () => {
    const text = 'Tiếng Việt có dấu 🐍';
    const wrapped = wrapBracketedPaste(text);
    expect(wrapped.startsWith(BRACKETED_PASTE_BEGIN)).toBe(true);
    expect(wrapped.endsWith(BRACKETED_PASTE_END)).toBe(true);
    const inner = wrapped.slice(BRACKETED_PASTE_BEGIN.length, -BRACKETED_PASTE_END.length);
    expect(inner).toBe(text);
  });

  it('preserves embedded CR/LF and CRLF without translation', () => {
    const text = 'line one\nline two\r\nline three\r';
    expect(wrapBracketedPaste(text)).toBe(
      `${BRACKETED_PASTE_BEGIN}line one\nline two\r\nline three\r${BRACKETED_PASTE_END}`,
    );
  });

  it('marks use the canonical CSI 200/201 parameter bytes', () => {
    expect(BRACKETED_PASTE_BEGIN).toBe('\u001b[200~');
    expect(BRACKETED_PASTE_END).toBe('\u001b[201~');
  });
});

describe('shouldWrapBracketedPaste — wrap policy', () => {
  it('always wraps when mode is always', () => {
    expect(shouldWrapBracketedPaste({ byteLength: 1, lineCount: 1, mode: 'always' })).toBe(true);
  });

  it('never wraps when mode is never', () => {
    expect(
      shouldWrapBracketedPaste({ byteLength: 100_000, lineCount: 200, mode: 'never' }),
    ).toBe(false);
  });

  it('auto wraps multi-line pastes regardless of byte size', () => {
    expect(shouldWrapBracketedPaste({ byteLength: 4, lineCount: 2, mode: 'auto' })).toBe(true);
  });

  it('auto wraps single-line pastes past the confirm byte threshold', () => {
    expect(
      shouldWrapBracketedPaste({
        byteLength: PASTE_CONFIRM_BYTES + 1,
        lineCount: 1,
        mode: 'auto',
      }),
    ).toBe(true);
  });

  it('auto skips wrapping single-line small pastes', () => {
    expect(shouldWrapBracketedPaste({ byteLength: 4, lineCount: 1, mode: 'auto' })).toBe(false);
  });
});

describe('prepareBracketedPasteText — convenience', () => {
  it('returns original text when wrap is not requested', () => {
    expect(prepareBracketedPasteText('hi', 'never', 1, 2)).toBe('hi');
    expect(prepareBracketedPasteText('hi', 'auto', 1, 2)).toBe('hi');
  });

  it('returns wrapped text when wrap is requested', () => {
    expect(prepareBracketedPasteText('a\nb', 'auto', 2, 3)).toBe(
      `${BRACKETED_PASTE_BEGIN}a\nb${BRACKETED_PASTE_END}`,
    );
    expect(prepareBracketedPasteText('a\nb', 'always', 1, 1)).toBe(
      `${BRACKETED_PASTE_BEGIN}a\nb${BRACKETED_PASTE_END}`,
    );
  });
});

describe('formatPasteByteLength', () => {
  it('formats bytes', () => {
    expect(formatPasteByteLength(0)).toBe('0 B');
    expect(formatPasteByteLength(512)).toBe('512 B');
  });

  it('formats kibibytes with one decimal', () => {
    expect(formatPasteByteLength(1024)).toBe('1.0 KiB');
    expect(formatPasteByteLength(2560)).toBe('2.5 KiB');
  });

  it('formats mebibytes with two decimals', () => {
    expect(formatPasteByteLength(1024 * 1024)).toBe('1.00 MiB');
    expect(formatPasteByteLength(1024 * 1024 * 2 + 1024 * 512)).toBe('2.50 MiB');
  });
});
