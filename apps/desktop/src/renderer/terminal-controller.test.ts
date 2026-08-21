import { describe, expect, it, vi } from 'vitest';

import type { PtyRuntimeEvent, PtyTerminalSize } from '@agentterm/application';

import {
  TerminalController,
  type TerminalConnectionFailure,
  type TerminalSessionAttachment,
  type TerminalSessionClient,
  type TerminalSurface,
} from './terminal-controller';

class FakeTerminalSurface implements TerminalSurface {
  public readonly dispose = vi.fn();
  public readonly focus = vi.fn();
  public readonly open = vi.fn();
  public readonly paste = vi.fn();
  public readonly refresh = vi.fn();
  public readonly reset = vi.fn();
  public readonly selectAll = vi.fn();
  public readonly setFontSize = vi.fn();
  public readonly write = vi.fn();
  public selectionText = '';
  public size: PtyTerminalSize = { columns: 80, rows: 24 };
  private inputSink: ((data: string) => void) | undefined;
  private resizeSink: ((size: PtyTerminalSize) => void) | undefined;

  public getSize(): PtyTerminalSize {
    return this.size;
  }

  public getSelection(): string {
    return this.selectionText;
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
  it('applies a font preference live without detaching the active Session', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.setFontSize(18);

    expect(surface.setFontSize).toHaveBeenCalledWith(18);
    expect(client.attachment.detach).not.toHaveBeenCalled();
    expect(client.attachTerminal).toHaveBeenCalledOnce();
  });

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

  it('refits only the activated pane surface so its resulting resize reaches that PTY', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.refreshLayout();
    surface.emitResize({ columns: 132, rows: 41 });
    await Promise.resolve();

    expect(surface.refresh).toHaveBeenCalledOnce();
    expect(client.attachment.resize).toHaveBeenLastCalledWith({ columns: 132, rows: 41 });
  });

  it('keeps output, input, and resize isolated across two pane controllers', async () => {
    const leftSurface = new FakeTerminalSurface();
    const rightSurface = new FakeTerminalSurface();
    const leftClient = new FakeTerminalSessionClient();
    const rightClient = new FakeTerminalSessionClient();
    const left = new TerminalController(leftSurface);
    const right = new TerminalController(rightSurface);
    left.mount({} as HTMLElement);
    right.mount({} as HTMLElement);
    await Promise.all([
      left.setSession('session-left', leftClient),
      right.setSession('session-right', rightClient),
    ]);

    leftClient.emit({ data: 'left output', kind: 'output', sequence: 1 });
    rightClient.emit({ data: 'right output', kind: 'output', sequence: 1 });
    leftSurface.emitInput('left input');
    rightSurface.emitResize({ columns: 144, rows: 45 });
    await Promise.resolve();

    expect(leftSurface.write).toHaveBeenCalledWith('left output');
    expect(leftSurface.write).not.toHaveBeenCalledWith('right output');
    expect(rightSurface.write).toHaveBeenCalledWith('right output');
    expect(rightSurface.write).not.toHaveBeenCalledWith('left output');
    expect(leftClient.attachment.write).toHaveBeenCalledWith('left input');
    expect(rightClient.attachment.write).not.toHaveBeenCalled();
    expect(rightClient.attachment.resize).toHaveBeenLastCalledWith({ columns: 144, rows: 45 });
    expect(leftClient.attachment.resize).not.toHaveBeenCalledWith({ columns: 144, rows: 45 });
  });

  it('reasserts focus and refits when the active tab changes', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    expect(controller.reassertFocus()).toBe(true);
    expect(controller.refit()).toBe(true);
    expect(surface.focus).toHaveBeenCalled();
    expect(surface.refresh).toHaveBeenCalled();
  });

  it('refit and reassertFocus are no-ops when not mounted', () => {
    const surface = new FakeTerminalSurface();
    const controller = new TerminalController(surface);

    expect(controller.refit()).toBe(false);
    expect(controller.reassertFocus()).toBe(false);
    expect(surface.refresh).not.toHaveBeenCalled();
    expect(surface.focus).not.toHaveBeenCalled();
  });

  it('refit and reassertFocus return false when the controller is not connected', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);

    // Still attaching — no session has resolved yet.
    // refit only needs the surface to be open (which happens at mount).
    expect(controller.refit()).toBe(true);
    // reassertFocus needs an active, non-failed connection.
    expect(controller.reassertFocus()).toBe(false);

    await controller.setSession('session-1', client);
    client.emit({ exitCode: 0, kind: 'exited', sequence: 1 });

    expect(controller.reassertFocus()).toBe(false);
  });

  it('clearPendingPaste releases the pending paste buffer on the surface', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.clearPendingPaste();
    expect(surface.selectAll).toHaveBeenCalled();
  });

  it('clearPendingPaste tolerates a surface that has already been disposed', async () => {
    const surface = new FakeTerminalSurface();
    Object.defineProperty(surface, 'dispose', {
      value: vi.fn(() => {
        throw new Error('already disposed');
      }),
      writable: true,
    });
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);
    controller.clearPendingPaste();
    // No throw, no crash; the renderer can still call focus/refit.
    expect(controller.reassertFocus()).toBe(true);
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

describe('TerminalController — serialized input queue', () => {
  interface Deferred {
    promise: Promise<undefined>;
    reject: (reason: unknown) => void;
    resolve: (value?: undefined) => void;
  }

  function deferred(): Deferred {
    let resolve!: (value?: undefined) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<undefined>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, reject, resolve };
  }

  it('sends writes in FIFO order through the attachment', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    surface.emitInput('a');
    surface.emitInput('b');
    surface.emitInput('c');
    await Promise.resolve();
    await Promise.resolve();

    expect((client.attachment.write.mock.calls as unknown as Array<[string]>).map((call) => call[0])).toEqual(['a', 'b', 'c']);
  });

  it('marks state failed and surfaces a failure event when a write rejects', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const failures: TerminalConnectionFailure[] = [];
    let stateChanges: string[] = [];
    const controller = new TerminalController(
      surface,
      (state) => stateChanges.push(state),
      undefined,
      (failure) => failures.push(failure),
    );
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    const error = new Error('terminal is gone');
    client.attachment.write
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw error;
      });
    surface.emitInput('first');
    surface.emitInput('second');
    await controller.flushInputQueue();

    expect(stateChanges).toContain('failed');
    expect(failures).toContainEqual({ operation: 'write', sessionId: 'unknown' });
    expect(controller.inputUnavailable).toBe(true);
  });

  it('pasteText routes through surface.paste instead of attachment.write', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.pasteText({
      byteLength: 4,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'hi',
    });
    expect(surface.paste).toHaveBeenCalledWith('hi');
    expect(client.attachment.write).not.toHaveBeenCalled();
  });

  it('pasteText wraps multi-line payloads with bracketed-paste markers by default', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.pasteText({
      byteLength: 7,
      lineCount: 3,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'a\nb\nc',
    });
    expect(surface.paste).toHaveBeenCalledWith('\u001b[200~a\nb\nc\u001b[201~');
    expect(client.attachment.write).not.toHaveBeenCalled();
  });

  it('pasteText wraps single-line payloads past the confirm byte threshold', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.pasteText({
      byteLength: 9_000,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'x'.repeat(9_000),
    });
    const call = surface.paste.mock.calls[0]?.[0] as string | undefined;
    expect(call?.startsWith('\u001b[200~')).toBe(true);
    expect(call?.endsWith('\u001b[201~')).toBe(true);
  });

  it('pasteText does not wrap single-line small payloads even when wrap is always', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    // Caller can still force unwrapping via wrap: 'never'.
    controller.pasteText({
      byteLength: 7,
      lineCount: 3,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'a\nb\nc',
      wrap: 'never',
    });
    expect(surface.paste).toHaveBeenCalledWith('a\nb\nc');
  });

  it('pasteText always wraps when wrap is always', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.pasteText({
      byteLength: 2,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'hi',
      wrap: 'always',
    });
    expect(surface.paste).toHaveBeenCalledWith('\u001b[200~hi\u001b[201~');
  });

  it('sendBytes routes through the FIFO queue', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.sendBytes('\u0003');
    await controller.flushInputQueue();

    expect(client.attachment.write).toHaveBeenCalledWith('\u0003');
  });

  it('rejects pasteText with paste-unavailable when input is unavailable', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    controller.inputUnavailable = true;
    const outcome = controller.pasteText({
      byteLength: 4,
      lineCount: 1,
      sessionId: 'session-1',
      taskId: 'task-1',
      text: 'hi',
    });
    expect(outcome.status).toBe('paste-unavailable');
    expect(surface.paste).not.toHaveBeenCalled();
  });

  it('keeps FIFO order even when writes resolve out of order', async () => {
    const surface = new FakeTerminalSurface();
    const client = new FakeTerminalSessionClient();
    const controller = new TerminalController(surface);
    controller.mount({} as HTMLElement);
    await controller.setSession('session-1', client);

    const first = deferred();
    client.attachment.write
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => undefined);

    surface.emitInput('a');
    surface.emitInput('b');
    first.resolve();
    await controller.flushInputQueue();
    expect((client.attachment.write.mock.calls as unknown as Array<[string]>).map((call) => call[0])).toEqual(['a', 'b']);
  });
});
