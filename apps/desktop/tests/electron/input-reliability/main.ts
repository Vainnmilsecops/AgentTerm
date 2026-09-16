import { TerminalController } from '../../../src/renderer/terminal-controller';
import {
  dispatchConfirmPaste,
  dispatchPasteText,
  handleKeyEvent,
} from '../../../src/renderer/terminal-input-glue';
import { XtermTerminalSurface } from '../../../src/renderer/xterm-terminal-surface';

async function verify(): Promise<string> {
  const surfaces: XtermTerminalSurface[] = [];
  const controllers: TerminalController[] = [];
  const outputs: string[][] = [[], []];
  const assert = (condition: boolean, label: string) => {
    if (!condition) throw new Error(label);
  };
  try {
    for (let index = 0; index < 2; index++) {
      const host = document.createElement('div');
      host.style.cssText = 'width:600px;height:220px';
      document.body.append(host);
      const surface = new XtermTerminalSurface();
      surfaces.push(surface);
      const controller = new TerminalController(surface);
      controllers.push(controller);
      controller.mount(host);
      await controller.setSession(`session-${index}`, {
        attachTerminal: async () => ({
          detach() {},
          resize: async () => {},
          write: async (data) => {
            outputs[index]!.push(data);
          },
        }),
      });
    }
    const controller = controllers[0]!;
    const surface = surfaces[0]!;
    const terminal = surface.getTerminal();
    const send = async (text: string) => {
      const result = dispatchPasteText(text, {
        controller,
        sessionId: 'session-0',
        taskId: 'task-0',
      });
      if (result.pending) dispatchConfirmPaste(result.pending, controller);
      await controller.flushInputQueue();
    };
    await send('Tiếng Việt 🚀');
    assert(outputs[0]!.join('') === 'Tiếng Việt 🚀', 'Unicode paste');
    outputs[0]!.length = 0;
    await new Promise<void>((resolve) => terminal.write('\x1b[?2004h', resolve));
    await send('a\r\nb\nc');
    assert(
      outputs[0]!.join('') === '\x1b[200~a\rb\rc\x1b[201~',
      'single bracketed paste with normalized lines',
    );
    outputs[0]!.length = 0;
    await send('/agtx:brainstorm\n');
    assert(
      outputs[0]!.join('') === '\x1b[200~/agtx:brainstorm\r\x1b[201~',
      'pasted slash command stays literal',
    );
    outputs[0]!.length = 0;
    controller.sendBytes('\x03');
    await controller.flushInputQueue();
    assert(outputs[0]!.join('') === '\x03', 'raw interrupt');
    outputs[0]!.length = 0;
    await send('x'.repeat(1_048_577));
    assert(outputs[0]!.length === 0, 'oversized paste rejected');
    assert(outputs[1]!.length === 0, 'split pane isolation');
    let copied = '';
    await new Promise<void>((resolve) => terminal.write('selected', resolve));
    terminal.selectAll();
    handleKeyEvent(
      { ctrlKey: true, isComposing: false, key: 'c', keyCode: 67, metaKey: false, shiftKey: false },
      {
        controller,
        hasSelection: () => terminal.hasSelection(),
        getSelection: () => terminal.getSelection(),
        onCopy: (text) => {
          copied = text;
        },
        onPasteFromClipboard: () => '',
      },
    );
    await Promise.resolve();
    assert(copied.includes('selected'), 'xterm selection copy');
    assert(outputs[0]!.length === 0, 'copy does not interrupt');
    return 'PASS: Unicode, normalized bracketed paste, literal slash paste, raw interrupt, oversized rejection, pane isolation, selection copy';
  } finally {
    controllers.forEach((controller) => controller.dispose());
  }
}

Object.assign(window, {
  inputReliabilityResult: verify().then(
    (message) => ({ ok: true, message }),
    (error: Error) => ({ ok: false, message: error.message }),
  ),
});
