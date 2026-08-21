import type { IBufferRange, Terminal } from '@xterm/xterm';

/**
 * Sibling of `registerTerminalLinkProvider` that turns absolute filesystem
 * paths inside the persisted primary Task Worktree into Ctrl+click
 * hyperlinks. Path classification itself is owned by the Application use
 * case `resolveTerminalLinkTarget` so the renderer never decides trust.
 *
 * The provider only underlines tokens the resolver classifies as
 * `worktree-file`; every other classification (including `external-url`)
 * is silently dropped here because the URL provider already handles it.
 */

export type WorktreeFileActivator = (event: MouseEvent, absolutePath: string) => void;

export interface WorktreeFileResolverResult {
  readonly activate: WorktreeFileActivator;
  readonly absolutePath: string;
  readonly text: string;
}

export type WorktreeFileResolver = (
  text: string,
) => WorktreeFileResolverResult | undefined;

// Windows drive letter (`C:\`, `D:\` …) followed by anything except
// whitespace and angle brackets. Backslashes are allowed because Windows
// paths use them. The regex deliberately does not anchor end-of-line
// because trailing punctuation belongs to a sentence, not the path.
const WINDOWS_DRIVE_PATTERN = /[A-Za-z]:(?:[^\s<>"]+)/gu;
// POSIX absolute path: leading `/` plus any run of characters that does
// not include whitespace, angle brackets, or quotes. Allows `/` so that
// nested directories are captured.
const POSIX_ABSOLUTE_PATTERN = /\/(?:[^\s<>"]+)/gu;

export interface RegisterWorktreeFileLinkProviderOptions {
  readonly resolve: WorktreeFileResolver;
  readonly terminal: Terminal;
}

export interface IDisposableWorktreeFileLinkProvider {
  dispose(): void;
}

export function registerWorktreeFileLinkProvider(
  options: RegisterWorktreeFileLinkProviderOptions,
): IDisposableWorktreeFileLinkProvider {
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
        readonly absolutePath: string;
        readonly activate: WorktreeFileActivator;
        readonly range: IBufferRange;
        readonly text: string;
      }> = [];
      const seen = new Set<number>();
      const consider = (raw: string, start: number): void => {
        const resolved = options.resolve(raw);
        if (resolved === undefined) return;
        if (resolved.absolutePath !== raw) return;
        const end = start + raw.length;
        if (seen.has(start)) return;
        seen.add(start);
        links.push({
          absolutePath: resolved.absolutePath,
          activate: resolved.activate,
          range: {
            end: { x: end + 1, y: bufferLineNumber },
            start: { x: start + 1, y: bufferLineNumber },
          },
          text: resolved.text,
        });
      };
      for (const match of text.matchAll(WINDOWS_DRIVE_PATTERN)) {
        consider(match[0], match.index ?? 0);
      }
      for (const match of text.matchAll(POSIX_ABSOLUTE_PATTERN)) {
        consider(match[0], match.index ?? 0);
      }
      callback(links.length === 0 ? undefined : links);
    },
  });
  return Object.freeze({ dispose: () => handle.dispose() });
}