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

  /**
   * Non-destructive `git merge-tree` virtual-merge probe.
   *
   * Runs from the persisted primary Worktree root (using `-C` so the
   * `--no-pager` / `--no-optional-locks` discipline holds) and parses
   * the human-readable `git merge-tree <base> <ours> -- <paths>` form
   * so the output is portable across Git 2.38+. The probe never
   * invokes a shell, never reads outside the Worktree path, and never
   * mutates the Worktree, the index, or the HEAD.
   *
   * Returns one of:
   * - `{ kind: 'clean' }` when Git reports no conflicts.
   * - `{ kind: 'conflicts', files }` listing each conflicted path with
   *   a bounded number of hunks (default 32 lines, hard cap 256).
   * - `{ kind: 'unavailable', reason }` when Git refuses to run
   *   (`NO_BASE_REF` for unknown base, `NOT_HEAD_ATTACHED` for
   *   detached/unborn HEAD, or `GIT_INSPECTION_FAILED` for any other
   *   failure). The reason is sanitized — no `git` stderr crosses the
   *   IPC boundary.
   */
  public async mergeTreeConflictProbe(
    worktreePath: string,
    baseRef: string,
    headRef: string,
    options: { readonly maxHunksPerFile?: number } = {},
  ): Promise<MergeTreeConflictProbeResult> {
    const worktree = await this.resolveWorkingTreeRoot(worktreePath);
    const headValidation = await this.validateMergeTreeRefs(worktree, headRef);
    if (headValidation.kind !== 'attached') {
      return Object.freeze({
        kind: 'unavailable' as const,
        reason: 'NOT_HEAD_ATTACHED' as const,
      });
    }
    const baseValidation = await this.validateMergeTreeRefs(worktree, baseRef);
    if (baseValidation.kind === 'unknown') {
      return Object.freeze({
        kind: 'unavailable' as const,
        reason: 'NO_BASE_REF' as const,
      });
    }
    let result: GitCommandResult;
    try {
      result = await this.run(worktree, ['merge-tree', baseRef, headRef]);
    } catch (error) {
      if (error instanceof GitCliError && error.reason === 'NOT_AVAILABLE') {
        return Object.freeze({
          kind: 'unavailable' as const,
          reason: 'GIT_INSPECTION_FAILED' as const,
        });
      }
      throw error;
    }
    return parseMergeTreeConflictProbe(result.stdout, baseRef, headRef, options.maxHunksPerFile);
  }

  private async validateMergeTreeRefs(
    repositoryPath: string,
    refName: string,
  ): Promise<
    | { readonly kind: 'attached' }
    | { readonly kind: 'detached' }
    | { readonly kind: 'unborn' }
    | { readonly kind: 'unknown' }
  > {
    let showResult: GitCommandResult;
    try {
      showResult = await this.run(repositoryPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${refName}^{commit}`,
      ]);
    } catch {
      return Object.freeze({ kind: 'unknown' });
    }
    if (showResult.exitCode !== 0) {
      return Object.freeze({ kind: 'unknown' });
    }
    const trimmed = showResult.stdout.replace(/\r?\n$/u, '');
    if (trimmed.length === 0) {
      return Object.freeze({ kind: 'unknown' });
    }
    let headResult: GitCommandResult;
    try {
      headResult = await this.run(repositoryPath, ['rev-parse', '--symbolic-full-name', 'HEAD']);
    } catch {
      return Object.freeze({ kind: 'attached' });
    }
    const headTrimmed = headResult.stdout.replace(/\r?\n$/u, '');
    if (headTrimmed.length === 0 || headTrimmed === 'HEAD') {
      return Object.freeze({ kind: 'detached' });
    }
    return Object.freeze({ kind: 'attached' });
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

export async function findTrustedExecutable(configuredExecutable: string): Promise<string> {
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

export type MergeTreeConflictProbeResult =
  | {
      readonly baseRef: string;
      readonly headRef: string;
      readonly kind: 'clean';
    }
  | {
      readonly baseRef: string;
      readonly files: readonly MergeTreeConflictFile[];
      readonly headRef: string;
      readonly kind: 'conflicts';
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'GIT_INSPECTION_FAILED' | 'NO_BASE_REF' | 'NOT_HEAD_ATTACHED';
    };

export interface MergeTreeConflictFile {
  readonly hunks: readonly string[];
  readonly path: string;
}

const DEFAULT_MAX_HUNKS_PER_FILE = 32;
const HARD_MAX_HUNKS_PER_FILE = 256;

void DEFAULT_MAX_HUNKS_PER_FILE;
void HARD_MAX_HUNKS_PER_FILE;

/**
 * Parses the stdout of `git merge-tree <base> <head>` (the
 * non-write-tree form available since Git 2.27). Each conflicted
 * path is reported through:
 *
 *     CONFLICT (content): Merge conflict in <path>
 *
 * `git merge-tree` exits with status 0 whether or not there are
 * conflicts, so we parse the body line-by-line. We deliberately ignore
 * the binary-blob preamble (mode + hash lines) and focus on the
 * human-readable `CONFLICT` / `Auto-merging` lines that always appear
 * exactly once per conflicted path.
 */
function parseMergeTreeConflictProbe(
  stdout: string,
  baseRef: string,
  headRef: string,
  maxHunksPerFile: number = DEFAULT_MAX_HUNKS_PER_FILE,
): MergeTreeConflictProbeResult {
  void maxHunksPerFile;
  const lines = stdout.split(/\r?\n/u);
  const paths: string[] = [];
  const hunksByPath = new Map<string, string[]>();
  for (const line of lines) {
    const conflictMatch = /^CONFLICT \([^)]+\): Merge conflict in (.+)$/u.exec(line);
    if (conflictMatch !== null) {
      const path = conflictMatch[1] ?? '';
      if (path.length === 0) {
        continue;
      }
      if (!hunksByPath.has(path)) {
        paths.push(path);
        hunksByPath.set(path, []);
      }
      continue;
    }
    if (line.startsWith('CONFLICT')) {
      continue;
    }
    if (line.startsWith('Auto-merging ')) {
      continue;
    }
    if (paths.length === 0) {
      continue;
    }
    if (line.trim().length === 0) {
      continue;
    }
    const lastPath = paths[paths.length - 1];
    if (lastPath === undefined) {
      continue;
    }
    const hunks = hunksByPath.get(lastPath) ?? [];
    hunks.push(line);
    hunksByPath.set(lastPath, hunks);
  }
  if (paths.length === 0) {
    return Object.freeze({ baseRef, headRef, kind: 'clean' });
  }
  const files: MergeTreeConflictFile[] = paths.map((path) =>
    Object.freeze({
      hunks: Object.freeze([...(hunksByPath.get(path) ?? [])]),
      path,
    }),
  );
  return Object.freeze({
    baseRef,
    files: Object.freeze(files),
    headRef,
    kind: 'conflicts',
  });
}

function freezeConflictFile(file: MergeTreeConflictFile): MergeTreeConflictFile {
  return Object.freeze({ hunks: Object.freeze([...file.hunks]), path: file.path });
}

void freezeConflictFile;
