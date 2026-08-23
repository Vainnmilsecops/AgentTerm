import { describe, expect, it } from 'vitest';

import {
  INITIAL_MOUSE_MODE,
  MOUSE_MODE_TOOLTIP,
  isMouseModeActive,
  parseMouseModeChunk,
  type MouseMode,
  type MouseModeParseResult,
} from './terminal-mouse-mode-parser';

function feed(
  previous: MouseMode,
  ...chunks: string[]
): MouseModeParseResult {
  let state = previous;
  let pending: string | null = null;
  for (const chunk of chunks) {
    const result = parseMouseModeChunk(state, chunk, pending);
    state = result.mode;
    pending = result.pending;
  }
  return { mode: state, pending };
}

function expectProtocol(state: MouseMode, protocol: MouseMode['protocol']): void {
  expect(state.protocol).toBe(protocol);
}

describe('parseMouseModeChunk', () => {
  it('starts in NONE / no-SGR', () => {
    expect(INITIAL_MOUSE_MODE.protocol).toBe('NONE');
    expect(INITIAL_MOUSE_MODE.sgr).toBe(false);
    expect(isMouseModeActive(INITIAL_MOUSE_MODE)).toBe(false);
  });

  it('enables X10 on CSI ? 1000 h', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1000h', null);
    expectProtocol(result.mode, 'X10');
    expect(result.mode.sgr).toBe(false);
    expect(isMouseModeActive(result.mode)).toBe(true);
    expect(result.pending).toBeNull();
  });

  it('enables DRAG on CSI ? 1002 h', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1002h', null);
    expectProtocol(result.mode, 'DRAG');
    expect(isMouseModeActive(result.mode)).toBe(true);
  });

  it('enables ANY on CSI ? 1003 h', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1003h', null);
    expectProtocol(result.mode, 'ANY');
    expect(isMouseModeActive(result.mode)).toBe(true);
  });

  it('enables SGR encoding on CSI ? 1006 h without changing protocol', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1006h', null);
    expect(result.mode.protocol).toBe('NONE');
    expect(result.mode.sgr).toBe(true);
    expect(isMouseModeActive(result.mode)).toBe(true);
  });

  it('disables X10 on CSI ? 1000 l', () => {
    const enabled: MouseMode = { protocol: 'X10', sgr: false };
    const result = parseMouseModeChunk(enabled, '\u001b[?1000l', null);
    expectProtocol(result.mode, 'NONE');
    expect(result.mode.sgr).toBe(false);
  });

  it('disables SGR without touching protocol', () => {
    const enabled: MouseMode = { protocol: 'DRAG', sgr: true };
    const result = parseMouseModeChunk(enabled, '\u001b[?1006l', null);
    expectProtocol(result.mode, 'DRAG');
    expect(result.mode.sgr).toBe(false);
  });

  it('handles two set sequences concatenated in one chunk', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1000h\u001b[?1006h', null);
    expectProtocol(result.mode, 'X10');
    expect(result.mode.sgr).toBe(true);
  });

  it('handles sequences split across chunks', () => {
    const first = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?100', null);
    expect(first.mode).toBe(INITIAL_MOUSE_MODE);
    expect(first.pending).toBe('\u001b[?100');
    const second = parseMouseModeChunk(first.mode, '6h', first.pending);
    expectProtocol(second.mode, 'NONE');
    expect(second.mode.sgr).toBe(true);
  });

  it('handles sequences split across three chunks', () => {
    const after = feed(INITIAL_MOUSE_MODE, '\u001b[', '?', '1000h');
    expectProtocol(after.mode, 'X10');
    expect(after.pending).toBeNull();
  });

  it('handles chunk boundaries inside the digits', () => {
    const after = feed(INITIAL_MOUSE_MODE, '\u001b[?1', '000', 'h');
    expectProtocol(after.mode, 'X10');
  });

  it('ignores non-DEC private-mode sequences (CSI ? 7 h line wrap)', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?7h', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBeNull();
  });

  it('ignores a truncated sequence with no final byte', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1000', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBe('\u001b[?1000');
  });

  it('ignores a sequence with the wrong introducer', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b]1000h', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBeNull();
  });

  it('keeps a tail with non-h/l non-ESC terminator as pending', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1000a', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBe('\u001b[?1000a');
  });

  it('returns the same reference when nothing relevant was in the chunk', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, 'plain text\r\n$ ', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBeNull();
  });

  it('clears the protocol when a previously-set mode is reset', () => {
    const enabled: MouseMode = { protocol: 'DRAG', sgr: true };
    const result = parseMouseModeChunk(enabled, '\u001b[?1002l\u001b[?1006l', null);
    expectProtocol(result.mode, 'NONE');
    expect(result.mode.sgr).toBe(false);
    expect(isMouseModeActive(result.mode)).toBe(false);
  });

  it('tolerates an empty chunk', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBeNull();
  });

  it('does not switch protocol from DRAG to X10 by accident on partial recognition', () => {
    const drag: MouseMode = { protocol: 'DRAG', sgr: false };
    const result = parseMouseModeChunk(drag, '\u001b[?1000l', null);
    expectProtocol(result.mode, 'NONE');
  });

  it('survives a large ASCII chunk without changing state', () => {
    const filler = 'a'.repeat(4096);
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, filler, null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBeNull();
  });

  it('survives embedded ESC bytes that are not followed by CSI', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, 'text\u001b7more', null);
    expect(result.mode).toBe(INITIAL_MOUSE_MODE);
    expect(result.pending).toBeNull();
  });

  it('returns a new MouseMode reference when the protocol changes', () => {
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1002h', null);
    expect(result.mode).not.toBe(INITIAL_MOUSE_MODE);
    expect(result.mode).toEqual({ protocol: 'DRAG', sgr: false });
  });

  it('returns the same MouseMode reference when only the sgr flag stays the same', () => {
    const enabled: MouseMode = { protocol: 'X10', sgr: false };
    const result = parseMouseModeChunk(enabled, '\u001b[?1000h', null);
    expect(result.mode).toBe(enabled);
  });

  it('recovers from an interrupted sequence when the interrupting ESC starts a valid one', () => {
    // The first `\u001b[?1000` is interrupted by another ESC; the
    // second `\u001b[?1006h` is parsed fresh in the same chunk and
    // SGR is the only thing recognised. The first broken prefix is
    // dropped because the ESC clearly restarted a new attempt.
    const result = parseMouseModeChunk(INITIAL_MOUSE_MODE, '\u001b[?1000\u001b[?1006h', null);
    expect(result.mode.protocol).toBe('NONE');
    expect(result.mode.sgr).toBe(true);
    expect(result.pending).toBeNull();
  });
});

describe('MOUSE_MODE_TOOLTIP', () => {
  it('is a non-empty string that mentions Shift', () => {
    expect(typeof MOUSE_MODE_TOOLTIP).toBe('string');
    expect(MOUSE_MODE_TOOLTIP.length).toBeGreaterThan(0);
    expect(MOUSE_MODE_TOOLTIP).toContain('Shift');
  });
});