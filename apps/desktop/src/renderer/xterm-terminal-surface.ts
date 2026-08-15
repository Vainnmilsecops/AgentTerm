import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IDisposable } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { PtyTerminalSize } from '@agentterm/application';

import type { TerminalSurface } from './terminal-controller';
import { resolveTerminalTheme } from './terminal-theme';

export class XtermTerminalSurface implements TerminalSurface {
  private disposed = false;
  private fitFrame: number | undefined;
  private readonly fitAddon = new FitAddon();
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(size: PtyTerminalSize) => void>();
  private resizeObserver: ResizeObserver | undefined;
  private readonly subscriptions: IDisposable[];
  private readonly terminal: Terminal;
  private themeObserver: MutationObserver | undefined;

  public constructor() {
    this.terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily:
        "'JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 14,
      scrollback: 5_000,
      theme: readTerminalTheme(),
    });
    this.terminal.loadAddon(this.fitAddon);
    this.subscriptions = [
      this.terminal.onData((data) => {
        for (const listener of [...this.inputListeners]) {
          listener(data);
        }
      }),
      this.terminal.onResize(({ cols, rows }) => {
        const size = Object.freeze({ columns: cols, rows });
        for (const listener of [...this.resizeListeners]) {
          listener(size);
        }
      }),
    ];
  }

  public open(container: HTMLElement): void {
    if (this.disposed) {
      return;
    }
    this.terminal.open(container);
    this.applyTheme();
    this.themeObserver = new MutationObserver(() => this.applyTheme());
    this.themeObserver.observe(document.documentElement, {
      attributeFilter: ['data-theme'],
      attributes: true,
    });
    this.fit();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(container);
  }

  public getSize(): PtyTerminalSize {
    return Object.freeze({ columns: this.terminal.cols, rows: this.terminal.rows });
  }

  public onInput(sink: (data: string) => void): () => void {
    this.inputListeners.add(sink);
    return createIdempotentDisposer(() => this.inputListeners.delete(sink));
  }

  public onResize(sink: (size: PtyTerminalSize) => void): () => void {
    this.resizeListeners.add(sink);
    return createIdempotentDisposer(() => this.resizeListeners.delete(sink));
  }

  public write(data: string): void {
    if (!this.disposed) {
      this.terminal.write(data);
    }
  }

  public reset(): void {
    if (!this.disposed) {
      this.terminal.reset();
      this.terminal.clear();
    }
  }

  public focus(): void {
    if (!this.disposed) {
      this.terminal.focus();
    }
  }

  public refresh(): void {
    this.scheduleFit();
  }

  public setFontSize(fontSize: number): void {
    if (!this.disposed && Number.isInteger(fontSize) && fontSize >= 8 && fontSize <= 32) {
      this.terminal.options.fontSize = fontSize;
      this.scheduleFit();
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.fitFrame !== undefined) {
      cancelAnimationFrame(this.fitFrame);
      this.fitFrame = undefined;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.inputListeners.clear();
    this.resizeListeners.clear();
    this.terminal.dispose();
  }

  private scheduleFit(): void {
    if (this.disposed || this.fitFrame !== undefined) {
      return;
    }
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = undefined;
      this.fit();
    });
  }

  private applyTheme(): void {
    if (!this.disposed) this.terminal.options.theme = readTerminalTheme();
  }

  private fit(): void {
    if (this.disposed) {
      return;
    }
    const dimensions = this.fitAddon.proposeDimensions();
    if (dimensions === undefined || dimensions.cols < 1 || dimensions.rows < 1) {
      return;
    }
    this.fitAddon.fit();
  }
}

function readTerminalTheme() {
  if (typeof document === 'undefined') {
    return resolveTerminalTheme('dark', () => '');
  }
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return resolveTerminalTheme(root.dataset.theme === 'light' ? 'light' : 'dark', (name) =>
    styles.getPropertyValue(name),
  );
}

function createIdempotentDisposer(dispose: () => void): () => void {
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    dispose();
  };
}
