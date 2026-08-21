import type {
  AgentSessionTerminalAttachment,
  AttachAgentSessionTerminalInput,
  PtyRuntimeEvent,
  PtyTerminalSize,
} from '@agentterm/application';

import {
  type BracketedPasteWrap,
  prepareBracketedPasteText,
} from './terminal-paste-controller';

export type TerminalConnectionState = 'empty' | 'attaching' | 'connected' | 'exited' | 'failed';

export type TerminalSessionAttachment = AgentSessionTerminalAttachment;

export interface TerminalSessionClient {
  attachTerminal(input: AttachAgentSessionTerminalInput): Promise<TerminalSessionAttachment>;
}

export interface TerminalSurface {
  dispose(): void;
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

interface ActiveAttachment {
  readonly attachment: TerminalSessionAttachment;
  readonly generation: number;
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
  /**
   * Bracketed-paste policy. Defaults to `auto` (multi-line or > PASTE_CONFIRM_BYTES
   * bytes wrap in CSI 200/201~ markers). Callers can force `always`/`never`.
   */
  readonly wrap?: BracketedPasteWrap;
}

export interface TerminalPasteOutcome {
  readonly failure: TerminalConnectionFailure | undefined;
  readonly status: 'accepted' | 'confirmed' | 'paste-unavailable' | 'rejected';
}

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
  private readonly pendingWrites: Array<Promise<unknown>> = [];
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

  public mount(container: HTMLElement): void {
    if (this.disposed || this.inputSubscription !== undefined) {
      return;
    }
    this.surface.open(container);
    this.inputSubscription = this.surface.onInput((data) => {
      this.enqueueWrite(data, 'write');
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
      this.inputUnavailable
    ) {
      this.failureSink?.({
        operation: paste === undefined ? 'write' : 'paste',
        sessionId: current?.attachment === undefined ? 'no-session' : 'unknown',
      });
      return { failure: undefined, status: 'paste-unavailable' };
    }
    if (paste !== undefined) {
      const wrapMode: BracketedPasteWrap = paste.wrap ?? 'auto';
      const payload = prepareBracketedPasteText(
        text,
        wrapMode,
        paste.lineCount,
        paste.byteLength,
      );
      this.surface.paste(payload);
    } else {
      this.enqueueWrite(text, 'write');
    }
    return {
      failure: undefined,
      status: paste === undefined ? 'accepted' : 'confirmed',
    };
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
    const attachment = current.attachment;
    const sessionId = 'unknown';
    const write = attachment.write(data).catch((error) => {
      this.inputUnavailable = true;
      this.updateState('failed');
      this.failureSink?.({ operation, sessionId });
      throw error;
    });
    this.pendingWrites.push(write);
  }

  public async setSession(
    sessionId: string | undefined,
    client: TerminalSessionClient | undefined,
  ): Promise<void> {
    const generation = ++this.generation;
    this.detachActive();

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

    this.active = { attachment, generation };
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
  }

  /** Read-only access to the surface for the render layer. */
  public getSurface(): TerminalSurface {
    return this.surface;
  }

  /**
   * Test seam ù awaits the serialized write queue. Production callers should
   * not depend on this; it exists so renderer tests can observe FIFO order
   * and post-failure state without polling internal state.
   */
  public async flushInputQueue(): Promise<void> {
    try {
      await Promise.all<void>(this.pendingWrites.map((p) => p.catch(() => undefined)) as Array<Promise<void>>);
    } catch {
      // Error already surfaced via failure sink; tests assert post-failure state.
    }
  }

  private detachActive(): void {
    const current = this.active;
    this.active = undefined;
    if (current !== undefined) {
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
