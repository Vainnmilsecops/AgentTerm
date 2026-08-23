/**
 * Pure incremental parser for DEC private mouse-mode escape sequences.
 *
 * xterm.js 6.0.0 implements mouse forwarding internally through its
 * `CoreMouseService`, but that service is private — consumers cannot
 * observe which protocol the active TUI has requested. AgentTerm
 * detects the mode itself by watching the PTY byte stream and
 * recognising the small set of DEC private mode set/reset sequences
 * that modern TUIs use to opt into mouse reporting.
 *
 * The recognisable sequences (after the standard CSI introducer) are:
 *
 *   CSI ? 1000 h   -> X10 (button-event tracking)
 *   CSI ? 1002 h   -> DRAG (button + motion with button held)
 *   CSI ? 1003 h   -> ANY (motion without buttons, hover, etc.)
 *   CSI ? 1006 h   -> SGR extended encoding (paired with one of the above)
 *
 * Lowercase `l` instead of `h` clears the mode. The parser is total:
 * malformed bytes leave the state unchanged, and a sequence split
 * across two chunks is recognised as long as the caller passes the
 * unfinished remainder as `pending` on the next call.
 */

export type MouseProtocol = 'NONE' | 'X10' | 'DRAG' | 'ANY';

export interface MouseMode {
  readonly protocol: MouseProtocol;
  readonly sgr: boolean;
}

export const INITIAL_MOUSE_MODE: MouseMode = Object.freeze({
  protocol: 'NONE',
  sgr: false,
});

export interface MouseModeParseResult {
  readonly mode: MouseMode;
  /**
   * The unfinished tail of the chunk, if any. Pass it as `pending`
   * on the next call so a sequence split across chunks is still
   * recognised. `null` when the chunk ended cleanly.
   */
  readonly pending: string | null;
}

export const MOUSE_MODE_TOOLTIP =
  'Active TUI requested mouse reporting. Shift+right-click forwards button-2 to it.';

const ESC = '\u001b';
const SGR_MODE = 1006;
const MOUSE_MODES = new Set<number>([1000, 1002, 1003]);

/**
 * Walk a chunk of PTY output and return the next mouse-mode state.
 *
 * The caller passes the previous `pending` remainder as the third
 * argument; on the first call pass `null`. The returned `pending`
 * must be threaded through the next call. The `mode` field is the
 * same reference (`===`) when nothing relevant was in the chunk.
 */
export function parseMouseModeChunk(
  previous: MouseMode,
  chunk: string,
  pending: string | null,
): MouseModeParseResult {
  let state = previous;
  let buffer = pending !== null ? pending + chunk : chunk;
  let index = 0;
  const length = buffer.length;
  while (index < length) {
    const escIndex = buffer.indexOf(ESC, index);
    if (escIndex < 0) {
      return { mode: state, pending: null };
    }
    if (escIndex + 1 >= length) {
      return { mode: state, pending: buffer.slice(escIndex) };
    }
    const next = buffer.charCodeAt(escIndex + 1);
    if (next !== 0x5b /* '[' */) {
      index = escIndex + 2;
      continue;
    }
    const afterCsi = escIndex + 2;
    if (afterCsi >= length) {
      return { mode: state, pending: buffer.slice(escIndex) };
    }
    if (buffer.charCodeAt(afterCsi) !== 0x3f /* '?' */) {
      index = afterCsi + 1;
      continue;
    }
    const parsed = readMouseModeSequence(buffer, afterCsi, length);
    if (parsed === undefined) {
      // Bail when the digit run ends without an `h`/`l` terminator.
      // ESC bytes mean the original sequence is dead and a new one
      // may start in the same chunk; anything else (e.g. `a`) is
      // malformed and we keep the tail as pending in case it is a
      // longer sequence the inner reader did not recognise.
      const offendingIndex = paramEndForReader(buffer, afterCsi + 1);
      if (offendingIndex >= length) {
        const pending = buffer.slice(escIndex);
        return { mode: state, pending: pending.length > 64 ? null : pending };
      }
      if (buffer.charCodeAt(offendingIndex) === 0x1b /* ESC */) {
        index = offendingIndex;
        continue;
      }
      const pending = buffer.slice(escIndex);
      return { mode: state, pending: pending.length > 64 ? null : pending };
    }
    state = applyMouseMode(state, parsed);
    index = parsed.endIndex;
  }
  return { mode: state, pending: null };
}

/**
 * Returns true when the mouse mode has any signal worth showing in
 * the pane chrome (either the protocol is not `NONE` or SGR encoding
 * is on).
 */
export function isMouseModeActive(mode: MouseMode): boolean {
  return mode.protocol !== 'NONE' || mode.sgr;
}

interface MouseModeParse {
  readonly final: 'h' | 'l';
  readonly mode: number;
  readonly endIndex: number;
}

/**
 * Walk a digit run starting at `startIndex` (the first digit) and
 * return the index just past it. Returns `startIndex` when there is
 * no digit at all, or `>= length` when the run runs off the end of
 * the buffer. Used by both the inner reader and the bail path so
 * the "interrupted by ESC" recovery can locate the offending byte.
 */
function paramEndForReader(buffer: string, startIndex: number): number {
  let index = startIndex;
  const length = buffer.length;
  while (index < length) {
    const code = buffer.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) {
      index += 1;
      continue;
    }
    if (code === 0x3b /* ';' */) {
      index += 1;
      continue;
    }
    return index;
  }
  return index;
}

function readMouseModeSequence(
  buffer: string,
  startIndex: number,
  length: number,
): MouseModeParse | undefined {
  if (startIndex >= length || buffer.charCodeAt(startIndex) !== 0x3f /* '?' */) {
    return undefined;
  }
  const paramStart = startIndex + 1;
  const paramEnd = paramEndForReader(buffer, paramStart);
  if (paramEnd === paramStart) return undefined;
  if (paramEnd >= length) return undefined;
  const finalCode = buffer.charCodeAt(paramEnd);
  if (finalCode !== 0x68 /* 'h' */ && finalCode !== 0x6c /* 'l' */) {
    return undefined;
  }
  const firstParam = buffer.slice(paramStart, paramEnd);
  const firstSemi = firstParam.indexOf(';');
  const head = firstSemi < 0 ? firstParam : firstParam.slice(0, firstSemi);
  const mode = Number.parseInt(head, 10);
  if (!Number.isFinite(mode)) return undefined;
  return {
    endIndex: paramEnd + 1,
    final: finalCode === 0x68 ? 'h' : 'l',
    mode,
  };
}

function applyMouseMode(
  state: MouseMode,
  parsed: MouseModeParse,
): MouseMode {
  const set = parsed.final === 'h';
  if (parsed.mode === SGR_MODE) {
    if (state.sgr === set) return state;
    return { protocol: state.protocol, sgr: set };
  }
  if (!MOUSE_MODES.has(parsed.mode)) return state;
  const nextProtocol: MouseProtocol = !set
    ? 'NONE'
    : parsed.mode === 1000
      ? 'X10'
      : parsed.mode === 1002
        ? 'DRAG'
        : 'ANY';
  if (state.protocol === nextProtocol) return state;
  return { protocol: nextProtocol, sgr: state.sgr };
}