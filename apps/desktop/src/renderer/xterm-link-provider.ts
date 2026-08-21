import type { IBufferRange, Terminal } from '@xterm/xterm';

/**
 * Lightweight xterm LinkProvider factory that matches HTTP/HTTPS URLs and
 * delegates the click action to a caller-supplied resolver.
 *
 * The provider intentionally does not parse file paths here. Path resolution
 * belongs to the Application use case `resolveTerminalLinkTarget` because
 * only Domain knows the persisted Worktree root.
 */

export type TerminalLinkActivator = (event: MouseEvent, text: string) => void;

export interface TerminalLinkResolverResult {
  readonly activate: TerminalLinkActivator;
  readonly text: string;
}

export type TerminalLinkResolver = (text: string) => TerminalLinkResolverResult | undefined;

const URL_PATTERN = /https?:\/\/[^\s<>"'`\\)]+/giu;

export interface RegisterTerminalLinkProviderOptions {
  readonly terminal: Terminal;
  readonly resolve: TerminalLinkResolver;
}

export interface IDisposableLinkProvider {
  dispose(): void;
}

export function registerTerminalLinkProvider(
  options: RegisterTerminalLinkProviderOptions,
): IDisposableLinkProvider {
  const handle = options.terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = options.terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (line === undefined) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (text.length === 0) {
        callback(undefined);
        return;
      }
      const links: Array<{
        readonly activate: TerminalLinkActivator;
        readonly range: IBufferRange;
        readonly text: string;
      }> = [];
      for (const match of text.matchAll(URL_PATTERN)) {
        const candidate = match[0];
        const resolved = options.resolve(candidate);
        if (resolved === undefined) continue;
        const start = match.index ?? 0;
        const end = start + candidate.length;
        links.push({
          activate: resolved.activate,
          range: {
            end: { x: end + 1, y: bufferLineNumber },
            start: { x: start + 1, y: bufferLineNumber },
          },
          text: resolved.text,
        });
      }
      callback(links.length === 0 ? undefined : links);
    },
  });
  return Object.freeze({ dispose: () => handle.dispose() });
}