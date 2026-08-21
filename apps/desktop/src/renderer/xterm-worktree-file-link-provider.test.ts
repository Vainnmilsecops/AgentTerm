import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Terminal } from '@xterm/xterm';

import {
  registerWorktreeFileLinkProvider,
  type RegisterWorktreeFileLinkProviderOptions,
  type WorktreeFileResolver,
  type WorktreeFileResolverResult,
} from './xterm-worktree-file-link-provider';

interface FakeTerminalLine {
  readonly text: string;
  readonly translateToString?: ((trim: boolean) => string) | undefined;
}

interface LinkDescriptor {
  readonly absolutePath: string;
  readonly activate: (event: MouseEvent, value: string) => void;
  readonly range: { start: { x: number; y: number }; end: { x: number; y: number } };
  readonly text: string;
}

function createFakeTerminal(lines: ReadonlyArray<FakeTerminalLine | undefined>): {
  readonly terminal: Terminal;
  readonly trigger: (
    lineNumber: number,
    callback: (links: ReadonlyArray<LinkDescriptor> | undefined) => void,
  ) => void;
} {
  let activeProvider:
    | {
        provideLinks: (
          bufferLineNumber: number,
          callback: (links: ReadonlyArray<LinkDescriptor> | undefined) => void,
        ) => void;
      }
    | undefined;
  const withMethod = (
    line: FakeTerminalLine | undefined,
  ): FakeTerminalLine | undefined => {
    if (line === undefined) return undefined;
    return {
      text: line.text,
      translateToString: (): string => line.text,
    };
  };
  const terminal = {
    buffer: {
      active: {
        getLine: (lineNumber: number): FakeTerminalLine | undefined =>
          withMethod(lines[lineNumber]),
      },
    },
    registerLinkProvider: (provider: {
      provideLinks(
        bufferLineNumber: number,
        callback: (links: ReadonlyArray<LinkDescriptor> | undefined) => void,
      ): void;
    }): { dispose: () => void } => {
      activeProvider = provider;
      return { dispose: (): void => undefined };
    },
  } as unknown as Terminal;
  return {
    terminal,
    trigger: (lineNumber, callback): void => {
      activeProvider?.provideLinks(lineNumber, callback);
    },
  };
}

describe('registerWorktreeFileLinkProvider', () => {
  const onActivate = vi.fn<(absolutePath: string) => void>();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runProvider(
    lines: ReadonlyArray<FakeTerminalLine | undefined>,
    resolver: WorktreeFileResolver,
    lineNumber: number,
  ): ReadonlyArray<LinkDescriptor> | undefined {
    const { terminal, trigger } = createFakeTerminal(lines);
    const provider = registerWorktreeFileLinkProvider({
      resolve: resolver,
      terminal,
    } as RegisterWorktreeFileLinkProviderOptions);
    expect(provider).toBeDefined();
    let received: ReadonlyArray<LinkDescriptor> | undefined;
    trigger(lineNumber, (links) => {
      received = links;
    });
    return received;
  }

  function makeResolver(
    candidates: Record<string, true>,
  ): WorktreeFileResolver {
    return (raw: string): WorktreeFileResolverResult | undefined => {
      if (candidates[raw] !== true) return undefined;
      return {
        activate: (_event, value) => onActivate(value),
        absolutePath: raw,
        text: raw,
      };
    };
  }

  it('underlines a Windows drive path inside the worktree', () => {
    const absolutePath = 'C:\\repo\\src\\renderer\\index.ts';
    const resolver = makeResolver({ [absolutePath]: true });
    const links = runProvider([{ text: absolutePath }], resolver, 1);
    expect(links).toBeDefined();
    expect(links).toHaveLength(1);
    expect(links?.[0]?.absolutePath).toBe(absolutePath);
    expect(links?.[0]?.range.start.x).toBe(1);
    expect(links?.[0]?.range.start.y).toBe(1);
  });

  it('underlines a POSIX absolute path inside the worktree', () => {
    const absolutePath = '/home/x/repo/src/index.ts';
    const resolver = makeResolver({ [absolutePath]: true });
    const links = runProvider([{ text: absolutePath }], resolver, 1);
    expect(links).toBeDefined();
    expect(links).toHaveLength(1);
    expect(links?.[0]?.absolutePath).toBe(absolutePath);
  });

  it('delegates URL candidates to the resolver (which rejects them)', () => {
    const resolver = vi.fn<WorktreeFileResolver>(() => undefined);
    const links = runProvider(
      [{ text: 'https://example.com/repo/foo.ts' }],
      resolver,
      1,
    );
    expect(links).toBeUndefined();
    // The resolver is invoked for any candidate that matches the
    // syntactic pattern; classification itself lives in
    // `resolveTerminalLinkTarget`, not in this provider.
    expect(resolver).toHaveBeenCalled();
  });

  it('skips non-absolute candidates', () => {
    const resolver = vi.fn<WorktreeFileResolver>(() => undefined);
    const links = runProvider([{ text: 'foo bar baz' }], resolver, 1);
    expect(links).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns nothing when the resolver rejects every candidate', () => {
    const resolver = (): WorktreeFileResolverResult | undefined => undefined;
    const links = runProvider(
      [{ text: 'C:\\outside\\foo.ts /home/x/repo/bar.ts' }],
      resolver,
      1,
    );
    expect(links).toBeUndefined();
  });

  it('emits only worktree-file ranges, not external-url ranges', () => {
    const resolver = makeResolver({ 'C:\\repo\\inside.ts': true });
    const links = runProvider(
      [{ text: 'C:\\repo\\inside.ts https://example.com' }],
      resolver,
      1,
    );
    expect(links).toHaveLength(1);
    expect(links?.[0]?.absolutePath).toBe('C:\\repo\\inside.ts');
  });

  it('returns undefined when the buffer line is undefined', () => {
    const resolver = vi.fn<WorktreeFileResolver>(() => undefined);
    const { terminal, trigger } = createFakeTerminal([]);
    registerWorktreeFileLinkProvider({ resolve: resolver, terminal });
    let received: ReadonlyArray<LinkDescriptor> | undefined;
    trigger(99, (links) => {
      received = links;
    });
    expect(received).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns undefined when the buffer line text is empty', () => {
    const resolver = vi.fn<WorktreeFileResolver>(() => undefined);
    const links = runProvider([{ text: '' }], resolver, 1);
    expect(links).toBeUndefined();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('routes Ctrl+click activation through the resolved activator', () => {
    const absolutePath = 'C:\\repo\\src\\index.ts';
    const resolver = makeResolver({ [absolutePath]: true });
    const links = runProvider([{ text: absolutePath }], resolver, 1);
    expect(links).toHaveLength(1);
    const activate = links?.[0]?.activate;
    expect(activate).toBeDefined();
    // The activator signature accepts a `MouseEvent`-shaped object; we pass
    // a plain stub because vitest runs in the Node environment.
    activate?.({} as MouseEvent, absolutePath);
    expect(onActivate).toHaveBeenCalledWith(absolutePath);
  });

  it('ignores resolver results whose absolutePath does not match the candidate', () => {
    const resolver = (): WorktreeFileResolverResult | undefined => ({
      activate: (_event, value) => onActivate(value),
      absolutePath: 'C:\\something\\else.ts',
      text: 'C:\\something\\else.ts',
    });
    const links = runProvider([{ text: 'C:\\repo\\inside.ts' }], resolver, 1);
    expect(links).toBeUndefined();
  });
});