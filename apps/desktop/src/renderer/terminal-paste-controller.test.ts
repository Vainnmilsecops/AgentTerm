import { describe, expect, it } from 'vitest';

import {
  classifyPaste,
  evaluatePaste,
  PASTE_CONFIRM_BYTES,
  PAUSE_BREAK_BYTES,
  type PasteClassifier,
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
