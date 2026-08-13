import { describe, expect, it, vi } from 'vitest';

import type { PtyRuntimeEvent, PtyTerminalSize } from '@agentterm/application';

import {
  TerminalController,
  type TerminalSessionAttachment,
  type TerminalSessionClient,
  type TerminalSurface,
} from './terminal-controller';

class FakeTerminalSurface implements TerminalSurface {
  public readonly dispose = vi.fn();
  public readonly focus = vi.fn();
  public readonly open = vi.fn();
  public readonly reset = vi.fn();
  public readonly write = vi.fn();
  public size: PtyTerminalSize = { columns: 80, rows: 24 };
  private inputSink: ((data: string) => void) | undefined;
  private resizeSink: ((size: PtyTerminalSize) => void) | undefined;

  public getSize(): PtyTerminalSize {
    return this.size;
  }

  public onInput(sink: (data: string) => void): () => void {
    this.inputSink = sink;
    return () => {
      if (this.inputSink === sink) {
        this.inputSink = undefined;
      }
    };
  }

  public onResize(sink: (size: PtyTerminalSize) => void): () => void {
    this.resizeSink = sink;
    return () => {
      if (this.resizeSink === sink) {
        this.resizeSink = undefined;
      }
    };
  }

  public emitInput(data: string): void {
    this.inputSink?.(data);
  }

  public emitResize(size: PtyTerminalSize): void {
    this.size = size;
    this.resizeSink?.(size);
  }
}

class FakeTerminalAttachment implements TerminalSessionAttachment {
  public readonly detach = vi.fn();
  public readonly resize = vi.fn(async () => undefined);
  public readonly write = vi.fn(async () => undefined);
}

class FakeTerminalSessionClient implements TerminalSessionClient {
  public readonly attachment = new FakeTerminalAttachment();
  public readonly attachTerminal = vi.fn(
    async (input: {
      readonly eventSink: (event: PtyRuntimeEvent) => void;
      readonly sessionId: string;
    }) => {
      this.sink = input.eventSink;
      return this.attachment;
    },
  );
  private sink: ((event: PtyRuntimeEvent) => void) | undefined;

  public emit(event: PtyRuntimeEvent): void {
    this.sink?.(event);
  }
}

describe('TerminalController', () => {
  it('focuses the mounted terminal surface on explicit workspace navigation', () => {
    const surface = new FakeTerminalSurface();
    const controller = new TerminalController(surface);

    controller.mount({} as HTMLElement);
    controller.focus();

    expect(surface.focus).toHaveBeenCalledOnce();
  });

  it('renders exact Unicode output and forwards exact Unicode input to the attached session', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);

    await controller.setSession('session-1', client);
    client.emit({ data: 'Xin chào thế giới 👋\r\n', kind: 'output', sequence: 1 });
    surface.emitInput('Tiếng Việt 🚀\r');
    await Promise.resolve();

    expect(surface.write).toHaveBeenCalledWith('Xin chào thế giới 👋\r\n');
    expect(client.attachment.write).toHaveBeenCalledWith('Tiếng Việt 🚀\r');
    expect(controller.state).toBe('connected');
  });

  it('forwards the initial terminal size and later container-driven resizes', async () => {
    const surface = new FakeTerminalSurface();
    surface.size = { columns: 92, rows: 27 };
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);

    await controller.setSession('session-1', client);
    surface.emitResize({ columns: 121, rows: 39 });
    await Promise.resolve();

    expect(client.attachment.resize).toHaveBeenNthCalledWith(1, { columns: 92, rows: 27 });
    expect(client.attachment.resize).toHaveBeenNthCalledWith(2, { columns: 121, rows: 39 });
  });

  it('detaches the prior session once and ignores its late events when switching sessions', async () => {
    const surface = new FakeTerminalSurface();
    const first = new FakeTerminalSessionClient();
    const second = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);

    await controller.setSession('session-1', first);
    await controller.setSession('session-2', second);
    first.emit({ data: 'stale output', kind: 'output', sequence: 1 });
    second.emit({ data: 'current output', kind: 'output', sequence: 1 });

    expect(first.attachment.detach).toHaveBeenCalledOnce();
    expect(surface.reset).toHaveBeenCalledTimes(2);
    expect(surface.write).toHaveBeenCalledTimes(1);
    expect(surface.write).toHaveBeenCalledWith('current output');
  });

  it('keeps rendered output visible after exit while disabling input and never inferring Task Done', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const states: string[] = [];
    const controller = new TerminalController(surface, (state) => states.push(state));
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    client.emit({ data: 'final output\r\n', kind: 'output', sequence: 1 });
    client.emit({ exitCode: 0, kind: 'exited', sequence: 2 });
    surface.emitInput('must not be forwarded');
    await Promise.resolve();

    expect(surface.write).toHaveBeenCalledWith('final output\r\n');
    expect(surface.reset).toHaveBeenCalledOnce();
    expect(client.attachment.write).not.toHaveBeenCalled();
    expect(client.attachment.detach).toHaveBeenCalledOnce();
    expect(controller.state).toBe('exited');
    expect(states).toContain('exited');
  });

  it('keeps draining final output after fatal runtime failure until exit', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    client.emit({
      kind: 'failed',
      operation: 'runtime',
      reason: 'RUNTIME_FAILURE',
      sequence: 1,
    });
    surface.emitInput('disabled after failure');
    client.emit({ data: 'last recoverable frame\r\n', kind: 'output', sequence: 2 });
    client.emit({ exitCode: -1, kind: 'exited', sequence: 3 });
    await Promise.resolve();

    expect(client.attachment.write).not.toHaveBeenCalled();
    expect(surface.write).toHaveBeenCalledWith('last recoverable frame\r\n');
    expect(client.attachment.detach).toHaveBeenCalledOnce();
    expect(controller.state).toBe('failed');
  });

  it('publishes provider-neutral runtime events for workspace status refresh', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const events: PtyRuntimeEvent[] = [];
    const controller = new TerminalController(surface, undefined, (event) => events.push(event));
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    client.emit({ kind: 'started', sequence: 1 });
    client.emit({ exitCode: 0, kind: 'exited', sequence: 2 });

    expect(events).toEqual([
      { kind: 'started', sequence: 1 },
      { exitCode: 0, kind: 'exited', sequence: 2 },
    ]);
  });

  it('cleans subscriptions and late attachments idempotently on unmount', async () => {
    const surface = new FakeTerminalSurface();
    const attachment = new FakeTerminalAttachment();
    let resolveAttachment!: (attachment: TerminalSessionAttachment) => void;
    const client: TerminalSessionClient = {
      attachTerminal: vi.fn(
        () =>
          new Promise<TerminalSessionAttachment>((resolve) => {
            resolveAttachment = resolve;
          }),
      ),
    };
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);

    const attaching = controller.setSession('session-1', client);
    controller.dispose();
    controller.dispose();
    resolveAttachment(attachment);
    await attaching;
    surface.emitInput('ignored');
    surface.emitResize({ columns: 99, rows: 30 });

    expect(attachment.detach).toHaveBeenCalledOnce();
    expect(attachment.write).not.toHaveBeenCalled();
    expect(attachment.resize).not.toHaveBeenCalled();
    expect(surface.dispose).toHaveBeenCalledOnce();
  });
});
