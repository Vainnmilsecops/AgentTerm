import type {
  AgentSessionTerminalAttachment,
  AttachAgentSessionTerminalInput,
  PtyRuntimeEvent,
  PtyTerminalSize,
} from '@agentterm/application';

import { PAUSE_BREAK_BYTES } from './terminal-paste-controller';
import {
  INITIAL_MOUSE_MODE,
  type MouseMode,
  parseMouseModeChunk,
} from './terminal-mouse-mode-parser';
import { detectSlashCommand } from './terminal-keyboard-controller';

export type MouseModeListener = (mode: MouseMode) => void;

export type TerminalConnectionState = 'empty' | 'attaching' | 'connected' | 'exited' | 'failed';

export type TerminalSessionAttachment = AgentSessionTerminalAttachment;

export interface TerminalSessionClient {
  attachTerminal(input: AttachAgentSessionTerminalInput): Promise<TerminalSessionAttachment>;
}

export interface TerminalSurface {
  clearSearch(): void;
  dispose(): void;
  findSearch(input: TerminalSearchRequest): boolean;
  findSearchPrevious(input: TerminalSearchRequest): boolean;
  focus(): void;
  getSelection(): string;
  getSize(): PtyTerminalSize;
  onInput(sink: (data: string) => void): () => void;
  onResize(sink: (size: PtyTerminalSize) => void): () => void;
  open(container: HTMLElement): void;
  paste(text: string): void;
  refresh(): void;
  reset(): void;
  selectAll(): void;
  setFontSize(fontSize: number): void;
  write(data: string): void;
}

export interface TerminalSearchRequest {
  readonly caseSensitive: boolean;
  readonly mode: 'literal' | 'regex';
  readonly term: string;
}

interface ActiveAttachment {
  readonly attachment: TerminalSessionAttachment;
  readonly generation: number;
  readonly sessionId: string;
  readonly queue: Array<{ data: string; operation: 'paste' | 'write' }>;
  pendingBytes: number;
  draining?: Promise<void> | undefined;
}

export interface TerminalConnectionFailure {
  readonly operation: 'paste' | 'write';
  readonly sessionId: string;
}

export interface TerminalPasteRequest {
  readonly byteLength: number;
  readonly lineCount: number;
  readonly sessionId: string;
  readonly taskId: string;
  readonly text: string;
}

export interface TerminalPasteOutcome {
  readonly failure: TerminalConnectionFailure | undefined;
  readonly status: 'accepted' | 'confirmed' | 'paste-unavailable' | 'rejected';
}

export type SlashCommandKind = 'brainstorm' | 'merge-conflicts' | 'sweep';

export interface SlashCommandEvent {
  readonly kind: SlashCommandKind;
}

export type SlashCommandListener = (event: SlashCommandEvent) => void;

export class TerminalController {
  private active: ActiveAttachment | undefined;
  private disposed = false;
  private generation = 0;
  private inputSubscription: (() => void) | undefined;
  private resizeSubscription: (() => void) | undefined;
  private readonly eventObserver: ((event: PtyRuntimeEvent) => void) | undefined;
  private readonly failureSink: ((failure: TerminalConnectionFailure) => void) | undefined;
  private readonly stateSink: ((state: TerminalConnectionState) => void) | undefined;
  private readonly surface: TerminalSurface;
  private readonly mouseModeListeners = new Set<MouseModeListener>();
  private readonly slashCommandListeners = new Set<SlashCommandListener>();
  private readonly lineBuffer: string[] = [];
  private pasting = false;
  private mouseMode: MouseMode = INITIAL_MOUSE_MODE;
  private mouseModePending: string | null = null;
  public inputUnavailable = false;
  public state: TerminalConnectionState = 'empty';

  public constructor(
    surface: TerminalSurface,
    stateSink?: (state: TerminalConnectionState) => void,
    eventObserver?: (event: PtyRuntimeEvent) => void,
    failureSink?: (failure: TerminalConnectionFailure) => void,
  ) {
    this.surface = surface;
    this.stateSink = stateSink;
    this.eventObserver = eventObserver;
    this.failureSink = failureSink;
  }

  public onSlashCommand(listener: SlashCommandListener): () => void {
    this.slashCommandListeners.add(listener);
    return () => {
      this.slashCommandListeners.delete(listener);
    };
  }

  private emitSlashCommand(kind: SlashCommandKind): void {
    const event: SlashCommandEvent = { kind };
    for (const listener of this.slashCommandListeners) {
      try {
        listener(event);
      } catch {
        // Defensive: a misbehaving listener must never break the input pipeline.
      }
    }
  }

  public mount(container: HTMLElement): void {
    if (this.disposed || this.inputSubscription !== undefined) {
      return;
    }
    this.surface.open(container);
    this.inputSubscription = this.surface.onInput((data) => {
      this.trackInputAndForward(data);
    });
    this.resizeSubscription = this.surface.onResize((size) => {
      const current = this.active;
      if (
        current === undefined ||
        current.generation !== this.generation ||
        this.state !== 'connected'
      ) {
        return;
      }
      void current.attachment.resize(size).catch(() => undefined);
    });
  }

  /**
   * Paste text through xterm's bracketed-paste / line-ending normalization.
   *
   * The caller is responsible for any confirmation step; this method only sends
   * when the controller is attached and accepting input. Failures during the
   * underlying PTY write are surfaced via the configured failure sink and the
   * {@link TerminalConnectionState} becomes `failed`.
   */
  public pasteText(input: TerminalPasteRequest): TerminalPasteOutcome {
    return this.sendText(input.text, input);
  }

  /**
   * Send raw bytes (Ctrl+C / ETX) through the serialized write queue. Used by
   * the keyboard controller when the user requests an interrupt without a
   * selection.
   */
  public sendBytes(bytes: string): TerminalPasteOutcome {
    return this.sendText(bytes, undefined);
  }

  private sendText(text: string, paste: TerminalPasteRequest | undefined): TerminalPasteOutcome {
    const current = this.active;
    if (
      current === undefined ||
      current.generation !== this.generation ||
      this.state !== 'connected' ||
      this.inputUnavailable ||
      (paste !== undefined && paste.sessionId !== current.sessionId)
    ) {
      this.failureSink?.({
        operation: paste === undefined ? 'write' : 'paste',
        sessionId: current?.sessionId ?? 'no-session',
      });
      return { failure: undefined, status: 'paste-unavailable' };
    }
    if (paste !== undefined) {
      if (new TextEncoder().encode(text).length > PAUSE_BREAK_BYTES) {
        return { failure: undefined, status: 'rejected' };
      }
      this.pasting = true;
      try {
        this.surface.paste(text);
      } catch {
        this.failureSink?.({ operation: 'paste', sessionId: current.sessionId });
        return { failure: undefined, status: 'paste-unavailable' };
      } finally {
        this.pasting = false;
      }
    } else {
      this.enqueueWrite(text, 'write');
    }
    return {
      failure: undefined,
      status: paste === undefined ? 'accepted' : 'confirmed',
    };
  }

  private trackInputAndForward(data: string): void {
    if (this.pasting) {
      this.lineBuffer.length = 0;
      this.enqueueWrite(data, 'paste');
      return;
    }
    let cursor = 0;
    while (cursor < data.length) {
      const terminatorIndex = this.indexOfLineTerminator(data, cursor);
      if (terminatorIndex === -1) {
        // No Enter in this chunk: forward the whole chunk and extend the line
        // buffer with everything we received. Preserves the existing
        // write-chunk semantics used by the terminal-input tests.
        const chunk = data.slice(cursor);
        // Bounded command tracking; normal input is still forwarded immediately.
        if (this.lineBuffer.join('').length + chunk.length <= 64) this.lineBuffer.push(chunk);
        else this.lineBuffer.splice(0, this.lineBuffer.length, '\u0000');
        this.enqueueWrite(chunk, 'write');
        return;
      }
      const line = `${this.lineBuffer.join('')}${data.slice(cursor, terminatorIndex)}`;
      const terminator = data[terminatorIndex] as string;
      this.lineBuffer.length = 0;
      const detection = detectSlashCommand(line);
      if (detection !== undefined) {
        this.emitSlashCommand(detection.kind);
        // Drop the matched line + its Enter; nothing is forwarded to the PTY.
        // The user sees the overlay open instead of the literal command
        // reaching the agent shell.
        cursor = terminatorIndex + 1;
        continue;
      }
      const forwarded = `${data.slice(cursor, terminatorIndex)}${terminator}`;
      this.enqueueWrite(forwarded, 'write');
      cursor = terminatorIndex + 1;
    }
  }

  private indexOfLineTerminator(data: string, fromIndex: number): number {
    for (let index = fromIndex; index < data.length; index += 1) {
      const char = data[index];
      if (char === '\r' || char === '\n') {
        return index;
      }
    }
    return -1;
  }

  private enqueueWrite(data: string, operation: 'paste' | 'write'): void {
    const current = this.active;
    if (
      current === undefined ||
      current.generation !== this.generation ||
      this.state !== 'connected'
    ) {
      return;
    }
    const bytes = new TextEncoder().encode(data).length;
    if (current.pendingBytes + bytes > 2 * 1024 * 1024) {
      this.failInput(current, operation);
      return;
    }
    current.pendingBytes += bytes;
    current.queue.push({ data, operation });
    current.draining ??= this.drainInput(current).finally(() => {
      current.draining = undefined;
    });
  }

  private async drainInput(current: ActiveAttachment): Promise<void> {
    while (this.active === current && this.state === 'connected' && !this.inputUnavailable) {
      const next = current.queue.shift();
      if (next === undefined) break;
      try {
        await current.attachment.write(next.data);
      } catch {
        if (this.active === current) this.failInput(current, next.operation);
        break;
      } finally {
        current.pendingBytes -= new TextEncoder().encode(next.data).length;
      }
    }
  }

  private failInput(current: ActiveAttachment, operation: 'paste' | 'write'): void {
    current.queue.length = 0;
    this.inputUnavailable = true;
    this.updateState('failed');
    this.failureSink?.({ operation, sessionId: current.sessionId });
  }

  public async setSession(
    sessionId: string | undefined,
    client: TerminalSessionClient | undefined,
  ): Promise<void> {
    const generation = ++this.generation;
    this.detachActive();
    this.inputUnavailable = false;
    this.lineBuffer.length = 0;

    if (this.disposed) {
      return;
    }
    if (sessionId === undefined || client === undefined) {
      this.updateState('empty');
      return;
    }

    this.surface.reset();
    this.updateState('attaching');
    let exited = false;
    let fatalFailure = false;
    const eventSink = (event: PtyRuntimeEvent): void => {
      if (this.disposed || generation !== this.generation) {
        return;
      }
      safelyPublishEvent(this.eventObserver, event);
      if (event.kind === 'output') {
        this.updateMouseMode(event.data);
        this.surface.write(event.data);
        return;
      }
      if (event.kind === 'started') {
        this.updateState('connected');
        return;
      }
      if (event.kind === 'exited') {
        exited = true;
        this.updateState(fatalFailure ? 'failed' : 'exited');
        this.detachActive();
        return;
      }
      if (['cleanup', 'runtime', 'spawn'].includes(event.operation)) {
        fatalFailure = true;
        this.updateState('failed');
      }
    };

    let attachment: TerminalSessionAttachment;
    try {
      attachment = await client.attachTerminal({ eventSink, sessionId });
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.updateState('failed');
      }
      return;
    }

    if (this.disposed || generation !== this.generation || exited) {
      safelyDetach(attachment);
      return;
    }

    this.active = { attachment, generation, sessionId, queue: [], pendingBytes: 0 };
    if (fatalFailure) {
      return;
    }
    this.updateState('connected');
    await attachment.resize(this.surface.getSize()).catch(() => undefined);
    if (
      !this.disposed &&
      generation === this.generation &&
      this.active?.attachment === attachment
    ) {
      this.surface.focus();
    }
  }

  public focus(): void {
    if (!this.disposed && this.inputSubscription !== undefined) {
      this.surface.focus();
    }
  }

  public refreshLayout(): void {
    if (!this.disposed && this.inputSubscription !== undefined) {
      this.surface.refresh();
    }
  }

  /**
   * Idempotent focus restoration hook for tab/pane activation. Returns true
   * when the controller is attached and the underlying surface accepted the
   * focus call. Safe to call when the controller is not yet attached: returns
   * false and the renderer can retry on the next activation.
   */
  public reassertFocus(): boolean {
    if (this.disposed || this.inputSubscription === undefined) return false;
    if (this.state !== 'connected' || this.inputUnavailable) return false;
    this.surface.focus();
    return true;
  }

  /**
   * Idempotent fit hook for tab activation. Returns true when the surface
   * recomputed its dimensions. Safe to call when the controller is not yet
   * attached; the renderer can retry.
   */
  public refit(): boolean {
    if (this.disposed || this.inputSubscription === undefined) return false;
    this.surface.refresh();
    return true;
  }

  /**
   * Drops the current paste-confirmation dialog by clearing the visible
   * xterm selection that the user originally copied from. The renderer owns
   * the `PendingPasteConfirmation` state; this hook signals the controller to
   * release any surface state that would otherwise leak into the next paste.
   */
  public clearPendingPaste(): void {
    if (this.disposed || this.inputSubscription === undefined) return;
    // xterm keeps a pending programmatic paste buffer; clearing the selection
    // is the cleanest signal that the prior paste is no longer intended.
    try {
      this.surface.selectAll();
      this.surface.write('\u0000');
    } catch {
      // Surface may already be disposed by the renderer; ignore.
    }
  }

  /**
   * Forward a search request to the underlying xterm surface. Returns the
   * addon's `findNext`/`findPrevious` boolean, or `false` if the surface is
   * no longer attached. The renderer is responsible for keeping the search
   * bar's `lastResult` in sync via a follow-up `RECORD_RESULT` dispatch.
   */
  public findSearch(request: TerminalSearchRequest): boolean {
    if (this.disposed || this.inputSubscription === undefined) return false;
    return this.surface.findSearch(request);
  }

  public findSearchPrevious(request: TerminalSearchRequest): boolean {
    if (this.disposed || this.inputSubscription === undefined) return false;
    return this.surface.findSearchPrevious(request);
  }

  public clearSearch(): void {
    if (this.disposed || this.inputSubscription === undefined) return;
    this.surface.clearSearch();
  }

  public setFontSize(fontSize: number): void {
    if (!this.disposed) {
      this.surface.setFontSize(fontSize);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.generation += 1;
    this.detachActive();
    this.inputSubscription?.();
    this.inputSubscription = undefined;
    this.resizeSubscription?.();
    this.resizeSubscription = undefined;
    this.surface.dispose();
    this.mouseModeListeners.clear();
  }

  /** Read-only access to the surface for the render layer. */
  public getSurface(): TerminalSurface {
    return this.surface;
  }

  /**
   * Subscribe to mouse-mode changes detected from the PTY output
   * stream. The listener fires only when the mode reference changes
   * (the parser returns the same `===` object when nothing relevant
   * was in a chunk). Returns an idempotent unsubscriber.
   */
  public onMouseModeChange(listener: MouseModeListener): () => void {
    this.mouseModeListeners.add(listener);
    return () => {
      this.mouseModeListeners.delete(listener);
    };
  }

  /** Current mouse-mode snapshot. The parser reference is stable. */
  public getMouseMode(): MouseMode {
    return this.mouseMode;
  }

  private updateMouseMode(chunk: string): void {
    const result = parseMouseModeChunk(this.mouseMode, chunk, this.mouseModePending);
    this.mouseModePending = result.pending;
    if (result.mode === this.mouseMode) {
      return;
    }
    this.mouseMode = result.mode;
    for (const listener of [...this.mouseModeListeners]) {
      try {
        listener(result.mode);
      } catch {
        // Listener errors must not interrupt the PTY -> xterm pipeline.
      }
    }
  }

  /**
   * Test seam ? awaits the serialized write queue. Production callers should
   * not depend on this; it exists so renderer tests can observe FIFO order
   * and post-failure state without polling internal state.
   */
  public async flushInputQueue(): Promise<void> {
    await this.active?.draining;
  }

  private detachActive(): void {
    const current = this.active;
    this.active = undefined;
    if (current !== undefined) {
      current.queue.length = 0;
      safelyDetach(current.attachment);
    }
  }

  private updateState(state: TerminalConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.stateSink?.(state);
  }
}

function safelyPublishEvent(
  observer: ((event: PtyRuntimeEvent) => void) | undefined,
  event: PtyRuntimeEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Workspace observers cannot interrupt terminal rendering or attachment cleanup.
  }
}

function safelyDetach(attachment: TerminalSessionAttachment): void {
  try {
    attachment.detach();
  } catch {
    // Detach is cleanup-only and must not break renderer teardown or session switching.
  }
}
