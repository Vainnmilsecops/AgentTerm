import { describe, expect, it, vi } from 'vitest';

import type { PtyRuntimeEvent } from '@agentterm/application';

import {
  TerminalController,
  type TerminalSessionAttachment,
  type TerminalSessionClient,
  type TerminalSurface,
} from './terminal-controller';

class MinimalTerminalSurface implements TerminalSurface {
  public readonly clearSearch = vi.fn();
  public readonly dispose = vi.fn();
  public readonly findSearch = vi.fn(() => true);
  public readonly findSearchPrevious = vi.fn(() => true);
  public readonly focus = vi.fn();
  public readonly open = vi.fn();
  public readonly paste = vi.fn();
  public readonly refresh = vi.fn();
  public readonly reset = vi.fn();
  public readonly selectAll = vi.fn();
  public readonly setFontSize = vi.fn();
  public readonly write = vi.fn();
  public size = { columns: 80, rows: 24 };
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(size: { columns: number; rows: number }) => void>();

  public getSize(): { columns: number; rows: number } {
    return this.size;
  }

  public getSelection(): string {
    return '';
  }

  public onInput(sink: (data: string) => void): () => void {
    this.inputListeners.add(sink);
    return () => this.inputListeners.delete(sink);
  }

  public onResize(sink: (size: { columns: number; rows: number }) => void): () => void {
    this.resizeListeners.add(sink);
    return () => this.resizeListeners.delete(sink);
  }
}

class StubAttachment implements TerminalSessionAttachment {
  public readonly detach = vi.fn();
  public readonly resize = vi.fn(async () => undefined);
  public readonly write = vi.fn(async () => undefined);
}

class StubClient implements TerminalSessionClient {
  public readonly attachment = new StubAttachment();
  public readonly attachTerminal = vi.fn(
    async (input: { readonly eventSink: (event: PtyRuntimeEvent) => void; readonly sessionId: string }) => {
      this.sink = input.eventSink;
      return this.attachment;
    },
  );
  private sink: ((event: PtyRuntimeEvent) => void) | undefined;

  public emit(event: PtyRuntimeEvent): void {
    this.sink?.(event);
  }
}

describe('TerminalController.onMouseModeChange', () => {
  it('fires once per mode change across output events', async () => {
    const surface = new MinimalTerminalSurface();
    const client = new StubClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    const listener = vi.fn();
    const unsubscribe = controller.onMouseModeChange(listener);
    expect(listener).not.toHaveBeenCalled();

    client.emit({ data: '\u001b[?1002h', kind: 'output', sequence: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getMouseMode().protocol).toBe('DRAG');

    client.emit({ data: 'ordinary text\r\n', kind: 'output', sequence: 2 });
    expect(listener).toHaveBeenCalledTimes(1);

    client.emit({ data: '\u001b[?1006h', kind: 'output', sequence: 3 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(controller.getMouseMode().sgr).toBe(true);

    client.emit({ data: '\u001b[?1002l', kind: 'output', sequence: 4 });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(controller.getMouseMode().protocol).toBe('NONE');

    unsubscribe();
    client.emit({ data: '\u001b[?1003h', kind: 'output', sequence: 5 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('handles a sequence split across two output events', async () => {
    const surface = new MinimalTerminalSurface();
    const client = new StubClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    const listener = vi.fn();
    controller.onMouseModeChange(listener);

    client.emit({ data: '\u001b[?100', kind: 'output', sequence: 1 });
    expect(listener).not.toHaveBeenCalled();
    client.emit({ data: '6h', kind: 'output', sequence: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getMouseMode().sgr).toBe(true);
  });

  it('still forwards bytes to the surface after the parser runs', async () => {
    const surface = new MinimalTerminalSurface();
    const client = new StubClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    client.emit({ data: '\u001b[?1002h normal text', kind: 'output', sequence: 1 });
    expect(surface.write).toHaveBeenCalledWith('\u001b[?1002h normal text');
    expect(controller.getMouseMode().protocol).toBe('DRAG');
  });

  it('stops calling listeners after dispose', async () => {
    const surface = new MinimalTerminalSurface();
    const client = new StubClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    const listener = vi.fn();
    controller.onMouseModeChange(listener);

    controller.dispose();

    client.emit({ data: '\u001b[?1002h', kind: 'output', sequence: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});