import { execFile } from 'node:child_process';
import { constants, realpath } from 'node:fs';
import { access, opendir, stat } from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  sep,
} from 'node:path';

const gitEnvironmentAllowlist = new Set([
  'APPDATA',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR',
]);

export type GitWorkingTreeAccessFailure =
  | 'GIT_INSPECTION_FAILED'
  | 'GIT_NOT_AVAILABLE'
  | 'INVALID_PATH'
  | 'NOT_WORKING_TREE'
  | 'PATH_NOT_ACCESSIBLE'
  | 'PATH_NOT_DIRECTORY'
  | 'PATH_NOT_FOUND';

export class GitWorkingTreeAccessError extends Error {
  public constructor(public readonly reason: GitWorkingTreeAccessFailure) {
    super(reason);
    this.name = 'GitWorkingTreeAccessError';
  }
}

export class GitCliError extends Error {
  public constructor(public readonly reason: 'FAILED' | 'NOT_AVAILABLE' | 'OUTPUT_LIMIT') {
    super(reason);
    this.name = 'GitCliError';
  }
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface GitCommandOptions {
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

export class GitCli {
  private resolvedExecutable: Promise<string> | undefined;
  private resolvedVersion: Promise<GitVersion> | undefined;

  public constructor(private readonly configuredExecutable = 'git') {}

  public async resolveWorkingTreeRoot(inputPath: string): Promise<string> {
    validateInputPath(inputPath);
    const candidatePath = await inspectDirectory(inputPath);
    let result: GitCommandResult;

    try {
      result = await this.run(candidatePath, [
        'rev-parse',
        '--is-inside-work-tree',
        '--show-toplevel',
      ]);
    } catch (error) {
      throw mapCliAccessError(error);
    }

    if (result.exitCode !== 0) {
      throw new GitWorkingTreeAccessError('NOT_WORKING_TREE');
    }

    const lines = removeFinalLineEnding(result.stdout).split(/\r?\n/u);

    if (lines.length !== 2 || lines[0] !== 'true') {
      throw new GitWorkingTreeAccessError('GIT_INSPECTION_FAILED');
    }

    const gitRoot = lines[1];

    if (gitRoot === undefined || gitRoot.length === 0 || !isAbsolute(gitRoot)) {
      throw new GitWorkingTreeAccessError('GIT_INSPECTION_FAILED');
    }

    return canonicalizeGitRoot(gitRoot, candidatePath);
  }

  public async run(
    repositoryPath: string,
    arguments_: readonly string[],
    options: GitCommandOptions = {},
  ): Promise<GitCommandResult> {
    const executable = await this.getExecutable();
    return executeGit(
      executable,
      ['--no-pager', '--no-optional-locks', '-C', repositoryPath, ...arguments_],
      options,
    );
  }

  public async version(): Promise<GitVersion> {
    this.resolvedVersion ??= this.readVersion();
    return this.resolvedVersion;
  }

  private async getExecutable(): Promise<string> {
    this.resolvedExecutable ??= findTrustedExecutable(this.configuredExecutable);

    try {
      return await this.resolvedExecutable;
    } catch {
      throw new GitCliError('NOT_AVAILABLE');
    }
  }

  private async readVersion(): Promise<GitVersion> {
    const executable = await this.getExecutable();
    const result = await executeGit(
      executable,
      ['--no-pager', '--no-optional-locks', '--version'],
      {},
    );

    if (result.exitCode !== 0) {
      throw new GitCliError('FAILED');
    }

    const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:\..*)?$/u.exec(
      removeFinalLineEnding(result.stdout),
    );

    if (match === null) {
      throw new GitCliError('FAILED');
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3] ?? '0');

    if (![major, minor, patch].every(Number.isSafeInteger)) {
      throw new GitCliError('FAILED');
    }

    return Object.freeze({ major, minor, patch });
  }
}

export function isGitVersionAtLeast(
  version: GitVersion,
  requiredMajor: number,
  requiredMinor: number,
): boolean {
  return (
    version.major > requiredMajor ||
    (version.major === requiredMajor && version.minor >= requiredMinor)
  );
}

function validateInputPath(inputPath: string): void {
  if (inputPath.trim().length === 0 || inputPath.includes('\0') || !isAbsolute(inputPath)) {
    throw new GitWorkingTreeAccessError('INVALID_PATH');
  }
}

async function inspectDirectory(inputPath: string): Promise<string> {
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(inputPath));
    const metadata = await stat(canonicalPath);

    if (!metadata.isDirectory()) {
      throw new GitWorkingTreeAccessError('PATH_NOT_DIRECTORY');
    }

    const directory = await opendir(canonicalPath);
    await directory.close();
    return canonicalPath;
  } catch (error) {
    if (error instanceof GitWorkingTreeAccessError) {
      throw error;
    }

    throw new GitWorkingTreeAccessError(mapFileSystemError(error));
  }
}

async function canonicalizeGitRoot(gitRoot: string, candidatePath: string): Promise<string> {
  let rootPath: string;

  try {
    rootPath = normalize(await resolveNativeRealPath(gitRoot));
  } catch {
    throw new GitWorkingTreeAccessError('GIT_INSPECTION_FAILED');
  }

  const relativeCandidate = relative(rootPath, candidatePath);
  const escapesRoot =
    isAbsolute(relativeCandidate) ||
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${sep}`);

  if (escapesRoot) {
    throw new GitWorkingTreeAccessError('GIT_INSPECTION_FAILED');
  }

  return rootPath;
}

function resolveNativeRealPath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolvedPath) => {
      if (error === null) {
        resolve(resolvedPath);
      } else {
        reject(error);
      }
    });
  });
}

async function findTrustedExecutable(configuredExecutable: string): Promise<string> {
  if (isAbsolute(configuredExecutable)) {
    return inspectExecutable(configuredExecutable);
  }

  if (basename(configuredExecutable) !== configuredExecutable) {
    throw new Error('The Git executable must be an absolute path or a bare executable name.');
  }

  const pathValue = getEnvironmentVariable('PATH');

  if (pathValue === undefined) {
    throw new Error('PATH is unavailable.');
  }

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = removeSurroundingQuotes(rawDirectory);

    if (directory.length === 0 || !isAbsolute(directory)) {
      continue;
    }

    for (const executableName of createExecutableNames(configuredExecutable)) {
      try {
        return await inspectExecutable(join(directory, executableName));
      } catch {
        // Continue searching the remaining absolute PATH entries.
      }
    }
  }

  throw new Error('The Git executable was not found in an absolute PATH entry.');
}

function createExecutableNames(configuredExecutable: string): readonly string[] {
  if (process.platform !== 'win32') {
    return [configuredExecutable];
  }

  return extname(configuredExecutable).length > 0
    ? [configuredExecutable]
    : [`${configuredExecutable}.exe`];
}

async function inspectExecutable(executablePath: string): Promise<string> {
  const metadata = await stat(executablePath);

  if (!metadata.isFile()) {
    throw new Error('The configured Git executable is not a file.');
  }

  if (process.platform !== 'win32') {
    await access(executablePath, constants.X_OK);
  }

  return normalize(await resolveNativeRealPath(executablePath));
}

function getEnvironmentVariable(name: string): string | undefined {
  const normalizedName = name.toUpperCase();

  for (const [environmentName, value] of Object.entries(process.env)) {
    if (environmentName.toUpperCase() === normalizedName) {
      return value;
    }
  }

  return undefined;
}

function removeSurroundingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function executeGit(
  executable: string,
  arguments_: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    try {
      execFile(
        executable,
        [...arguments_],
        {
          cwd: dirname(executable),
          encoding: 'utf8',
          env: createGitEnvironment(),
          maxBuffer: options.maxBuffer ?? 64 * 1024,
          shell: false,
          timeout: options.timeout ?? 10_000,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error === null) {
            resolve(Object.freeze({ exitCode: 0, stdout }));
            return;
          }

          const errorCode = getErrorCode(error);

          if (typeof errorCode === 'number') {
            resolve(Object.freeze({ exitCode: errorCode, stdout }));
            return;
          }

          reject(
            new GitCliError(
              errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'OUTPUT_LIMIT'
                : isUnavailableProcessError(errorCode)
                  ? 'NOT_AVAILABLE'
                  : 'FAILED',
            ),
          );
        },
      );
    } catch (error) {
      const errorCode = getErrorCode(error);
      reject(new GitCliError(isUnavailableProcessError(errorCode) ? 'NOT_AVAILABLE' : 'FAILED'));
    }
  });
}

function createGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (gitEnvironmentAllowlist.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }

  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function mapFileSystemError(error: unknown): GitWorkingTreeAccessFailure {
  if (getErrorCode(error) === 'ENOENT') {
    return 'PATH_NOT_FOUND';
  }

  if (getErrorCode(error) === 'ENOTDIR') {
    return 'PATH_NOT_DIRECTORY';
  }

  return 'PATH_NOT_ACCESSIBLE';
}

function mapCliAccessError(error: unknown): GitWorkingTreeAccessError {
  return new GitWorkingTreeAccessError(
    error instanceof GitCliError && error.reason === 'NOT_AVAILABLE'
      ? 'GIT_NOT_AVAILABLE'
      : 'GIT_INSPECTION_FAILED',
  );
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}

function isUnavailableProcessError(errorCode: string | number | undefined): boolean {
  return (
    errorCode === 'EACCES' ||
    errorCode === 'ENOENT' ||
    errorCode === 'EPERM' ||
    errorCode === 'UNKNOWN'
  );
}

export function removeFinalLineEnding(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }

  if (value.endsWith('\n')) {
    return value.slice(0, -1);
  }

  return value;
}
