import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  parse,
  relative,
  sep,
} from 'node:path';

import {
  ProjectOpenError,
  type DiscoveredProject,
  type ProjectDiscovery,
  type ProjectOpenFailure,
} from '@agentterm/application';

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

export class LocalGitProjectDiscovery implements ProjectDiscovery {
  private resolvedGitExecutable: Promise<string> | undefined;

  public constructor(private readonly configuredGitExecutable = 'git') {}

  public async discover(inputPath: string): Promise<DiscoveredProject> {
    validateInputPath(inputPath);
    const gitExecutable = await this.resolveGitExecutable(inputPath);
    const candidatePath = await inspectDirectory(inputPath);
    const gitRoot = await this.resolveGitRoot(gitExecutable, candidatePath, inputPath);
    const rootPath = await canonicalizeGitRoot(gitRoot, candidatePath, inputPath);
    const pathIdentity = createPathIdentity(rootPath);

    return Object.freeze({
      id: `project-${createHash('sha256').update(pathIdentity).digest('hex')}`,
      name: basename(rootPath) || parse(rootPath).root,
      pathIdentity,
      rootPath,
    });
  }

  private async resolveGitExecutable(inputPath: string): Promise<string> {
    this.resolvedGitExecutable ??= findTrustedExecutable(this.configuredGitExecutable);

    try {
      return await this.resolvedGitExecutable;
    } catch {
      throw new ProjectOpenError('GIT_NOT_AVAILABLE', inputPath);
    }
  }

  private async resolveGitRoot(
    gitExecutable: string,
    candidatePath: string,
    inputPath: string,
  ): Promise<string> {
    let stdout: string;

    try {
      stdout = await executeGit(gitExecutable, candidatePath);
    } catch (error) {
      throw mapGitError(error, inputPath);
    }

    const lines = removeFinalLineEnding(stdout).split(/\r?\n/u);

    if (lines.length !== 2 || lines[0] !== 'true') {
      throw new ProjectOpenError('GIT_INSPECTION_FAILED', inputPath);
    }

    const rootPath = lines[1];

    if (rootPath === undefined || rootPath.length === 0 || !isAbsolute(rootPath)) {
      throw new ProjectOpenError('GIT_INSPECTION_FAILED', inputPath);
    }

    return rootPath;
  }
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

  const executableNames = createExecutableNames(configuredExecutable);

  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = removeSurroundingQuotes(rawDirectory);

    // Empty and relative PATH entries resolve against cwd, which may be an
    // untrusted repository selected by the user.
    if (directory.length === 0 || !isAbsolute(directory)) {
      continue;
    }

    for (const executableName of executableNames) {
      try {
        return await inspectExecutable(join(directory, executableName));
      } catch {
        // Continue searching the remaining trusted absolute PATH entries.
      }
    }
  }

  throw new Error('The Git executable was not found in an absolute PATH entry.');
}

function createExecutableNames(configuredExecutable: string): readonly string[] {
  if (process.platform !== 'win32') {
    return [configuredExecutable];
  }

  if (extname(configuredExecutable).length > 0) {
    return [configuredExecutable];
  }

  return [`${configuredExecutable}.exe`];
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

function validateInputPath(inputPath: string): void {
  if (inputPath.trim().length === 0 || inputPath.includes('\0') || !isAbsolute(inputPath)) {
    throw new ProjectOpenError('INVALID_PATH', inputPath);
  }
}

async function inspectDirectory(inputPath: string): Promise<string> {
  try {
    const canonicalPath = normalize(await resolveNativeRealPath(inputPath));
    const metadata = await stat(canonicalPath);

    if (!metadata.isDirectory()) {
      throw new ProjectOpenError('PATH_NOT_DIRECTORY', inputPath);
    }

    const directory = await opendir(canonicalPath);
    await directory.close();
    return canonicalPath;
  } catch (error) {
    if (error instanceof ProjectOpenError) {
      throw error;
    }

    throw new ProjectOpenError(mapFileSystemError(error), inputPath);
  }
}

async function canonicalizeGitRoot(
  gitRoot: string,
  candidatePath: string,
  inputPath: string,
): Promise<string> {
  let rootPath: string;

  try {
    rootPath = normalize(await resolveNativeRealPath(gitRoot));
  } catch {
    throw new ProjectOpenError('GIT_INSPECTION_FAILED', inputPath);
  }

  const relativeCandidate = relative(rootPath, candidatePath);
  const escapesRoot =
    isAbsolute(relativeCandidate) ||
    relativeCandidate === '..' ||
    relativeCandidate.startsWith(`..${sep}`);

  if (escapesRoot) {
    throw new ProjectOpenError('GIT_INSPECTION_FAILED', inputPath);
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

function executeGit(executable: string, repositoryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        '--no-optional-locks',
        '-C',
        repositoryPath,
        'rev-parse',
        '--is-inside-work-tree',
        '--show-toplevel',
      ],
      {
        cwd: dirname(executable),
        encoding: 'utf8',
        env: createGitEnvironment(),
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) {
          resolve(stdout);
        } else {
          reject(error);
        }
      },
    );
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
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function createPathIdentity(rootPath: string): string {
  return process.platform === 'win32' ? `win32:${rootPath}` : `posix:${rootPath}`;
}

function removeFinalLineEnding(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }

  if (value.endsWith('\n')) {
    return value.slice(0, -1);
  }

  return value;
}

function mapFileSystemError(error: unknown): ProjectOpenFailure {
  if (hasErrorCode(error, 'ENOENT')) {
    return 'PATH_NOT_FOUND';
  }

  if (hasErrorCode(error, 'ENOTDIR')) {
    return 'PATH_NOT_DIRECTORY';
  }

  return 'PATH_NOT_ACCESSIBLE';
}

function mapGitError(error: unknown, inputPath: string): ProjectOpenError {
  const errorCode = getErrorCode(error);

  if (
    errorCode === 'EACCES' ||
    errorCode === 'ENOENT' ||
    errorCode === 'EPERM' ||
    errorCode === 'UNKNOWN'
  ) {
    return new ProjectOpenError('GIT_NOT_AVAILABLE', inputPath);
  }

  if (isTimedOutProcess(error)) {
    return new ProjectOpenError('GIT_INSPECTION_FAILED', inputPath);
  }

  return new ProjectOpenError(
    typeof errorCode === 'number' ? 'NOT_GIT_REPOSITORY' : 'GIT_INSPECTION_FAILED',
    inputPath,
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return getErrorCode(error) === code;
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}

function isTimedOutProcess(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const processError = error as ExecFileException;
  return (
    processError.killed === true ||
    (processError.signal !== undefined && processError.signal !== null)
  );
}
