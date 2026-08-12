import type {
  AgentSessionTerminalAttachment,
  AttachAgentSessionTerminalInput,
  PtyRuntimeEvent,
  PtyTerminalSize,
} from '@agentterm/application';

export type TerminalConnectionState = 'empty' | 'attaching' | 'connected' | 'exited' | 'failed';

export type TerminalSessionAttachment = AgentSessionTerminalAttachment;

export interface TerminalSessionClient {
  attachTerminal(input: AttachAgentSessionTerminalInput): Promise<TerminalSessionAttachment>;
}

export interface TerminalSurface {
  dispose(): void;
  focus(): void;
  getSize(): PtyTerminalSize;
  onInput(sink: (data: string) => void): () => void;
  onResize(sink: (size: PtyTerminalSize) => void): () => void;
  open(container: HTMLElement): void;
  reset(): void;
  write(data: string): void;
}

interface ActiveAttachment {
  readonly attachment: TerminalSessionAttachment;
  readonly generation: number;
}

export class TerminalController {
  private active: ActiveAttachment | undefined;
  private disposed = false;
  private generation = 0;
  private inputSubscription: (() => void) | undefined;
  private resizeSubscription: (() => void) | undefined;
  private readonly stateSink: ((state: TerminalConnectionState) => void) | undefined;
  private readonly surface: TerminalSurface;
  public state: TerminalConnectionState = 'empty';

  public constructor(
    surface: TerminalSurface,
    stateSink?: (state: TerminalConnectionState) => void,
  ) {
    this.surface = surface;
    this.stateSink = stateSink;
  }

  public mount(container: HTMLElement): void {
    if (this.disposed || this.inputSubscription !== undefined) {
      return;
    }
    this.surface.open(container);
    this.inputSubscription = this.surface.onInput((data) => {
      const current = this.active;
      if (
        current === undefined ||
        current.generation !== this.generation ||
        this.state !== 'connected'
      ) {
        return;
      }
      void current.attachment.write(data).catch(() => undefined);
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

function safelyDetach(attachment: TerminalSessionAttachment): void {
  try {
    attachment.detach();
  } catch {
    // Detach is cleanup-only and must not break renderer teardown or session switching.
  }
}
