import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

import { findTrustedExecutable } from './git-cli';

const githubEnvironmentAllowlist = new Set([
  'APPDATA',
  'GH_CONFIG_DIR',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);

export class GitHubCli {
  private resolvedExecutable: Promise<string> | undefined;

  public constructor(private readonly configuredExecutable = 'gh') {}

  public async isAvailable(): Promise<boolean> {
    try {
      const result = await this.run(['--version'], 5_000, 64 * 1024);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  public async isAuthenticated(): Promise<boolean> {
    try {
      const result = await this.run(
        ['auth', 'status', '--active', '--hostname', 'github.com'],
        10_000,
        64 * 1024,
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  public async requestJson(
    method: 'GET' | 'POST',
    path: string,
    input?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!path.startsWith('/') || path.includes('\0') || path.length > 4096) {
      throw new Error('The GitHub API path is invalid.');
    }
    const serializedInput = input === undefined ? undefined : JSON.stringify(input);
    if (serializedInput !== undefined && Buffer.byteLength(serializedInput, 'utf8') > 64 * 1024) {
      throw new Error('The GitHub API input is too large.');
    }
    const result = await this.run(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        method,
        path,
        ...(serializedInput === undefined ? [] : ['--input', '-']),
      ],
      30_000,
      1024 * 1024,
      serializedInput,
    );
    if (result.exitCode !== 0) throw new Error('The GitHub API request failed.');
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error('The GitHub API response is invalid.');
    }
  }

  public async requestOptionalJson(path: string): Promise<unknown | undefined> {
    if (!path.startsWith('/') || path.includes('\0') || path.length > 4096) {
      throw new Error('The GitHub API path is invalid.');
    }
    const result = await this.run(
      ['api', '--hostname', 'github.com', '--method', 'GET', '--include', path],
      30_000,
      1024 * 1024,
    );
    return parseIncludedGithubResponse(result.exitCode, result.stdout);
  }

  private async executable(): Promise<string> {
    this.resolvedExecutable ??= findTrustedExecutable(this.configuredExecutable);
    return this.resolvedExecutable;
  }

  private async run(
    arguments_: readonly string[],
    timeout: number,
    maxBuffer: number,
    input?: string,
  ): Promise<{ readonly exitCode: number; readonly stdout: string }> {
    const executable = await this.executable();
    return new Promise((resolve, reject) => {
      try {
        const child = execFile(
          executable,
          [...arguments_],
          {
            cwd: dirname(executable),
            encoding: 'utf8',
            env: createGithubEnvironment(),
            maxBuffer,
            shell: false,
            timeout,
            windowsHide: true,
          },
          (error, stdout) => {
            if (error === null) {
              resolve(Object.freeze({ exitCode: 0, stdout }));
              return;
            }
            const code = readErrorCode(error);
            if (typeof code === 'number') {
              resolve(Object.freeze({ exitCode: code, stdout }));
            } else {
              reject(new Error('GitHub CLI execution failed.'));
            }
          },
        );
        child.stdin?.end(input);
      } catch {
        reject(new Error('GitHub CLI execution failed.'));
      }
    });
  }
}

function parseIncludedGithubResponse(exitCode: number, output: string): unknown | undefined {
  if (output.includes('\0')) throw new Error('The GitHub API response is invalid.');
  const lineEnding = output.indexOf('\n');
  if (lineEnding < 0) throw new Error('The GitHub API response is invalid.');
  const statusLine = output.slice(0, lineEnding).replace(/\r$/u, '');
  const match = /^HTTP\/\S+ ([0-9]{3})(?: .*)?$/u.exec(statusLine);
  const status = Number(match?.[1]);
  if (!Number.isInteger(status)) throw new Error('The GitHub API response is invalid.');
  const windowsHeaderEnd = output.indexOf('\r\n\r\n');
  const portableHeaderEnd = output.indexOf('\n\n');
  const headerEnd = windowsHeaderEnd >= 0 ? windowsHeaderEnd + 4 : portableHeaderEnd + 2;
  if (headerEnd < 2) throw new Error('The GitHub API response is invalid.');
  if (status === 404) return undefined;
  if (exitCode !== 0 || status < 200 || status >= 300) {
    throw new Error('The GitHub API request failed.');
  }
  try {
    return JSON.parse(output.slice(headerEnd)) as unknown;
  } catch {
    throw new Error('The GitHub API response is invalid.');
  }
}

function createGithubEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (githubEnvironmentAllowlist.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }
  environment.GH_PAGER = '';
  environment.GH_PROMPT_DISABLED = '1';
  environment.GH_NO_UPDATE_NOTIFIER = '1';
  environment.NO_COLOR = '1';
  return environment;
}

function readErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}
