import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { GitHubCli } from './github-cli';

afterEach(() => {
  execFileMock.mockReset();
});

describe('GitHub CLI command boundary', () => {
  it('sends PR data through bounded JSON stdin with structured no-shell arguments', async () => {
    const end = vi.fn();
    execFileMock.mockImplementation((_executable, _arguments, _options, callback) => {
      callback(null, '{"number":42}', 'provider diagnostic TOKEN=secret');
      return { stdin: { end } };
    });
    const cli = new GitHubCli(process.execPath);

    await expect(
      cli.requestJson('POST', '/repos/agentterm/AgentTerm/pulls', {
        base: 'main',
        body: 'Explicit body',
        head: 'agentterm/task/pr',
        title: 'Explicit title',
      }),
    ).resolves.toEqual({ number: 42 });

    expect(execFileMock).toHaveBeenCalledOnce();
    const [, arguments_, options] = execFileMock.mock.calls[0] as [
      string,
      readonly string[],
      { readonly env: NodeJS.ProcessEnv; readonly shell: boolean },
    ];
    expect(arguments_).toEqual([
      'api',
      '--hostname',
      'github.com',
      '--method',
      'POST',
      '/repos/agentterm/AgentTerm/pulls',
      '--input',
      '-',
    ]);
    expect(arguments_.join(' ')).not.toContain('Explicit body');
    expect(options.shell).toBe(false);
    expect(options.env).toMatchObject({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        base: 'main',
        body: 'Explicit body',
        head: 'agentterm/task/pr',
        title: 'Explicit title',
      }),
    );
  });

  it('checks active github.com authentication without asking gh to reveal a token', async () => {
    execFileMock.mockImplementation((_executable, _arguments, _options, callback) => {
      callback(null, '', '');
      return { stdin: { end: vi.fn() } };
    });
    const cli = new GitHubCli(process.execPath);

    await expect(cli.isAuthenticated()).resolves.toBe(true);

    const arguments_ = execFileMock.mock.calls[0]?.[1] as readonly string[];
    expect(arguments_).toEqual(['auth', 'status', '--active', '--hostname', 'github.com']);
    expect(arguments_).not.toContain('--show-token');
  });
});
