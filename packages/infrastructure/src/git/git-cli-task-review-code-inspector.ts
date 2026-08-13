import { createHash } from 'node:crypto';
import { realpath, type BigIntStats } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  TaskWorktreeLifecycleError,
  type TaskReviewCodeInspector,
  type TaskWorktree,
} from '@agentterm/application';
import type { TaskReviewChanges, TaskReviewCodeState } from '@agentterm/domain';

import { GitCli, isGitVersionAtLeast, removeFinalLineEnding } from './git-cli';

const maximumChangedPaths = 200;
const maximumGitOutputBytes = 64 * 1024 * 1024;
const maximumFingerprintBytes = 64 * 1024 * 1024;
const maximumFingerprintEntries = 10_000;
const fingerprintTimeoutMs = 30_000;
const gitTimeoutMs = 30_000;

interface CaptureContext {
  readonly baseCommitId: string;
  readonly branchName: string;
  readonly headCommitId: string;
  readonly repositoryRootPath: string;
  readonly taskId: string;
  readonly worktreePath: string;
  readonly worktreePathIdentity: string;
}

interface FullChanges {
  readonly committed: readonly string[];
  readonly conflicted: readonly string[];
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

interface IndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly path: string;
  readonly stage: number;
}

interface FingerprintBudget {
  readonly deadlineAt: number;
  remainingBytes: number;
}

interface StatusSnapshot {
  readonly conflicted: readonly string[];
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export class GitCliTaskReviewCodeInspector implements TaskReviewCodeInspector {
  private readonly git: GitCli;

  public constructor(configuredGitExecutable = 'git') {
    this.git = new GitCli(configuredGitExecutable);
  }

  public async inspect(worktree: TaskWorktree): Promise<TaskReviewCodeState> {
    const taskId = readTaskId(worktree);

    try {
      validateWorktree(worktree, taskId);
      const first = await this.capture(worktree);
      const second = await this.capture(worktree);

      if (!sameCapture(first, second)) {
        throw operationFailed(taskId);
      }

      return second;
    } catch (error) {
      if (error instanceof TaskWorktreeLifecycleError) {
        throw error;
      }

      throw operationFailed(taskId);
    }
  }

  private async capture(worktree: TaskWorktree): Promise<TaskReviewCodeState> {
    const deadlineAt = performance.now() + fingerprintTimeoutMs;
    const context = await this.verifyContext(worktree);
    const [committedResult, statusResult, indexResult, indexFlagResult] = await Promise.all([
      this.runDiff(context.worktreePath, [
        '--name-only',
        '-z',
        context.baseCommitId,
        context.headCommitId,
        '--',
      ]),
      this.git.run(
        context.worktreePath,
        [
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
          '--no-renames',
          '--no-ahead-behind',
          '--ignore-submodules=none',
        ],
        gitOptions(),
      ),
      this.git.run(
        context.worktreePath,
        ['ls-files', '--cached', '--stage', '-z', '--'],
        gitOptions(),
      ),
      this.git.run(context.worktreePath, ['ls-files', '--cached', '-v', '-z', '--'], gitOptions()),
    ]);
    const committed = parseNulPaths(committedResult, context.taskId);
    const status = parseStatus(statusResult, context.taskId);
    const indexEntries = parseIndexEntries(indexResult, context.taskId);
    assertSupportedIndexFlags(indexFlagResult, context.taskId);
    const changes: FullChanges = Object.freeze({
      committed,
      conflicted: status.conflicted,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
    });
    const fingerprint = await fingerprintCodeState(
      context,
      changes,
      statusResult.stdout,
      indexResult.stdout,
      indexFlagResult.stdout,
      indexEntries,
      deadlineAt,
    );

    return Object.freeze({
      baseCommitId: context.baseCommitId,
      branchName: context.branchName,
      changes: boundChanges(changes),
      fingerprint,
      headCommitId: context.headCommitId,
      schemaVersion: 1,
      worktreePathIdentity: context.worktreePathIdentity,
    });
  }

  private async verifyContext(worktree: TaskWorktree): Promise<CaptureContext> {
    const version = await this.git.version();
    if (!isGitVersionAtLeast(version, 2, 45)) {
      throw operationFailed(worktree.taskId);
    }

    const [worktreeRoot, repositoryRoot] = await Promise.all([
      this.git.resolveWorkingTreeRoot(worktree.worktreePath),
      this.git.resolveWorkingTreeRoot(worktree.repositoryRootPath),
    ]);
    if (
      !samePath(worktreeRoot, worktree.worktreePath) ||
      !samePath(repositoryRoot, worktree.repositoryRootPath) ||
      samePath(worktreeRoot, repositoryRoot) ||
      createPathIdentity(worktreeRoot) !== worktree.pathIdentity
    ) {
      throw worktreeMismatch(worktree.taskId);
    }

    const [worktreeCommonDirectory, repositoryCommonDirectory] = await Promise.all([
      this.readCommonDirectory(worktreeRoot, worktree.taskId),
      this.readCommonDirectory(repositoryRoot, worktree.taskId),
    ]);
    if (!samePath(worktreeCommonDirectory, repositoryCommonDirectory)) {
      throw worktreeMismatch(worktree.taskId);
    }

    const [branchResult, headResult, baseResult] = await Promise.all([
      this.git.run(worktreeRoot, ['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'], gitOptions()),
      this.git.run(
        worktreeRoot,
        ['rev-parse', '--verify', '--quiet', '--end-of-options', 'HEAD^{commit}'],
        gitOptions(),
      ),
      this.git.run(
        worktreeRoot,
        [
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${worktree.baseCommitId}^{commit}`,
        ],
        gitOptions(),
      ),
    ]);
    const expectedBranchRef = `refs/heads/${worktree.branchName}`;
    if (
      parseLine(branchResult, worktree.taskId) !== expectedBranchRef ||
      parseObjectId(baseResult, worktree.taskId) !== worktree.baseCommitId
    ) {
      throw worktreeMismatch(worktree.taskId);
    }
    const headCommitId = parseObjectId(headResult, worktree.taskId);
    await this.assertRegisteredWorktree(
      repositoryRoot,
      worktreeRoot,
      expectedBranchRef,
      headCommitId,
      worktree.taskId,
    );

    return Object.freeze({
      baseCommitId: worktree.baseCommitId,
      branchName: worktree.branchName,
      headCommitId,
      repositoryRootPath: repositoryRoot,
      taskId: worktree.taskId,
      worktreePath: worktreeRoot,
      worktreePathIdentity: worktree.pathIdentity,
    });
  }

  private async readCommonDirectory(repositoryPath: string, taskId: string): Promise<string> {
    const result = await this.git.run(
      repositoryPath,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      gitOptions(),
    );
    const commonDirectory = parseLine(result, taskId);
    if (!isAbsolute(commonDirectory)) {
      throw worktreeMismatch(taskId);
    }

    try {
      return normalize(await resolveNativeRealPath(commonDirectory));
    } catch {
      throw worktreeMismatch(taskId);
    }
  }

  private async assertRegisteredWorktree(
    repositoryRootPath: string,
    worktreePath: string,
    branchRef: string,
    headCommitId: string,
    taskId: string,
  ): Promise<void> {
    const result = await this.git.run(
      repositoryRootPath,
      ['worktree', 'list', '--porcelain', '-z'],
      gitOptions(),
    );
    if (result.exitCode !== 0 || !result.stdout.endsWith('\0')) {
      throw worktreeMismatch(taskId);
    }

    const records = parseWorktreeRecords(result.stdout, taskId).filter((record) =>
      samePath(record.path, worktreePath),
    );
    if (
      records.length !== 1 ||
      records[0]?.branchRef !== branchRef ||
      records[0]?.headCommitId !== headCommitId
    ) {
      throw worktreeMismatch(taskId);
    }
  }

  private runDiff(repositoryPath: string, arguments_: readonly string[]) {
    return this.git.run(
      repositoryPath,
      [
        '-c',
        'core.fsmonitor=false',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        ...arguments_,
      ],
      gitOptions(),
    );
  }
}

function validateWorktree(worktree: TaskWorktree, taskId: string): void {
  if (worktree === null || typeof worktree !== 'object') {
    throw worktreeMismatch(taskId);
  }
  for (const value of [
    worktree.baseRefName,
    worktree.branchName,
    worktree.pathIdentity,
    worktree.repositoryRootPath,
    worktree.taskId,
    worktree.worktreePath,
  ]) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
      throw worktreeMismatch(taskId);
    }
  }
  if (
    !isObjectId(worktree.baseCommitId) ||
    !isAbsolute(worktree.repositoryRootPath) ||
    !isAbsolute(worktree.worktreePath)
  ) {
    throw worktreeMismatch(taskId);
  }
}

function parseStatus(
  result: { readonly exitCode: number; readonly stdout: string },
  taskId: string,
): StatusSnapshot {
  if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith('\0'))) {
    throw operationFailed(taskId);
  }
  const conflicted = new Set<string>();
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();

  for (const record of splitNulRecords(result.stdout)) {
    if (record.startsWith('1 ')) {
      const fields = splitFixedFields(record, 8, taskId);
      const statusCode = fields[1];
      const submoduleState = fields[2];
      const path = fields[8];
      if (
        statusCode === undefined ||
        !/^[.MTADRCU]{2}$/u.test(statusCode) ||
        submoduleState === undefined ||
        !/^(?:N\.\.\.|S[C.][M.][U.])$/u.test(submoduleState) ||
        path === undefined
      ) {
        throw operationFailed(taskId);
      }
      assertSafeGitPath(path, taskId);
      if (submoduleState.startsWith('S')) {
        throw operationFailed(taskId);
      }
      if (statusCode[0] !== '.') {
        staged.add(path);
      }
      if (statusCode[1] !== '.') {
        unstaged.add(path);
      }
      continue;
    }

    if (record.startsWith('u ')) {
      const fields = splitFixedFields(record, 10, taskId);
      const submoduleState = fields[2];
      const path = fields[10];
      if (
        submoduleState === undefined ||
        !/^(?:N\.\.\.|S[C.][M.][U.])$/u.test(submoduleState) ||
        path === undefined
      ) {
        throw operationFailed(taskId);
      }
      assertSafeGitPath(path, taskId);
      if (submoduleState.startsWith('S')) {
        throw operationFailed(taskId);
      }
      conflicted.add(path);
      continue;
    }

    if (record.startsWith('? ') && record.length > 2) {
      const path = record.slice(2);
      assertSafeGitPath(path, taskId);
      untracked.add(path);
      continue;
    }

    throw operationFailed(taskId);
  }

  return Object.freeze({
    conflicted: sorted(conflicted),
    staged: sorted(staged),
    unstaged: sorted(unstaged),
    untracked: sorted(untracked),
  });
}

function parseIndexEntries(
  result: { readonly exitCode: number; readonly stdout: string },
  taskId: string,
): readonly IndexEntry[] {
  if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith('\0'))) {
    throw operationFailed(taskId);
  }
  const entries = splitNulRecords(result.stdout).map((record): IndexEntry => {
    const separator = record.indexOf('\t');
    if (separator <= 0) {
      throw operationFailed(taskId);
    }
    const metadata = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    if (
      metadata.length !== 3 ||
      !/^(?:100644|100755|120000|160000)$/u.test(metadata[0] ?? '') ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(metadata[1] ?? '') ||
      !/^[0-3]$/u.test(metadata[2] ?? '')
    ) {
      throw operationFailed(taskId);
    }
    assertSafeGitPath(path, taskId);
    return Object.freeze({
      mode: metadata[0]!,
      objectId: metadata[1]!,
      path,
      stage: Number(metadata[2]),
    });
  });
  return Object.freeze(entries);
}

async function fingerprintCodeState(
  context: CaptureContext,
  changes: FullChanges,
  rawStatus: string,
  rawIndex: string,
  rawIndexFlags: string,
  indexEntries: readonly IndexEntry[],
  deadlineAt: number,
): Promise<string> {
  const hash = createHash('sha256');
  addFrame(hash, 'agentterm-task-review-code-state-v1');
  addFrame(hash, 'ignored-path-policy:exclude-standard-v1');
  addFrame(hash, 'working-tree-content-policy:all-stage-zero-tracked-and-visible-untracked-v2');
  addFrame(hash, context.worktreePathIdentity);
  addFrame(hash, context.branchName);
  addFrame(hash, context.baseCommitId);
  addFrame(hash, context.headCommitId);
  addFrame(hash, rawStatus);
  addFrame(hash, rawIndex);
  addFrame(hash, rawIndexFlags);
  for (const category of [
    changes.committed,
    changes.conflicted,
    changes.staged,
    changes.unstaged,
    changes.untracked,
  ]) {
    for (const path of category) {
      addFrame(hash, path);
    }
    addFrame(hash, '\0category-end');
  }

  const entriesByPath = new Map<string, IndexEntry[]>();
  for (const entry of indexEntries) {
    const entries = entriesByPath.get(entry.path) ?? [];
    entries.push(entry);
    entriesByPath.set(entry.path, entries);
  }
  const stageZeroTrackedPaths = indexEntries
    .filter((entry) => entry.stage === 0)
    .map((entry) => entry.path);
  const filesystemPaths = [
    ...new Set([...stageZeroTrackedPaths, ...changes.conflicted, ...changes.untracked]),
  ].sort(compareStrings);
  if (filesystemPaths.length > maximumFingerprintEntries) {
    throw operationFailed(context.taskId);
  }
  const budget: FingerprintBudget = {
    deadlineAt,
    remainingBytes: maximumFingerprintBytes,
  };
  assertFingerprintWithinDeadline(budget, context.taskId);
  for (const path of filesystemPaths) {
    const entries = entriesByPath.get(path);
    const gitlink = entries !== undefined && entries.every((entry) => entry.mode === '160000');
    await addFilesystemEntry(hash, context.worktreePath, path, gitlink, context.taskId, budget);
  }
  assertFingerprintWithinDeadline(budget, context.taskId);
  return hash.digest('hex');
}

function assertSupportedIndexFlags(
  result: { readonly exitCode: number; readonly stdout: string },
  taskId: string,
): void {
  if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith('\0'))) {
    throw operationFailed(taskId);
  }
  for (const record of splitNulRecords(result.stdout)) {
    if (record.length < 3 || record[1] !== ' ') {
      throw operationFailed(taskId);
    }
    const tag = record[0];
    const path = record.slice(2);
    assertSafeGitPath(path, taskId);
    if (tag === 'S' || tag === undefined || /^[a-z]$/u.test(tag)) {
      throw operationFailed(taskId);
    }
  }
}

async function addFilesystemEntry(
  hash: ReturnType<typeof createHash>,
  rootPath: string,
  gitPath: string,
  allowGitlinkDirectory: boolean,
  taskId: string,
  budget: FingerprintBudget,
): Promise<void> {
  assertFingerprintWithinDeadline(budget, taskId);
  await assertNoSymlinkAncestors(rootPath, gitPath, taskId);
  const absolutePath = resolveGitPath(rootPath, gitPath, taskId);
  let before;
  try {
    before = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      addFrame(hash, `${gitPath}\0missing`);
      return;
    }
    throw operationFailed(taskId);
  }

  addFrame(hash, gitPath);
  addFrame(hash, before.mode.toString());
  if (before.isDirectory()) {
    if (!allowGitlinkDirectory) {
      throw operationFailed(taskId);
    }
    addFrame(hash, 'gitlink-directory');
    return;
  }
  if (before.isSymbolicLink()) {
    if (process.platform === 'win32') {
      throw operationFailed(taskId);
    }
    const expectedByteLength = reserveFingerprintBytes(budget, before.size, taskId);
    const target = await readlink(absolutePath, { encoding: 'buffer' });
    if (target.byteLength !== expectedByteLength) {
      throw operationFailed(taskId);
    }
    addFrame(hash, target);
  } else if (before.isFile()) {
    const expectedByteLength = reserveFingerprintBytes(budget, before.size, taskId);
    addFrame(hash, await hashFile(absolutePath, before, expectedByteLength, taskId, budget));
  } else {
    throw operationFailed(taskId);
  }

  let after;
  try {
    after = await lstat(absolutePath, { bigint: true });
  } catch {
    throw operationFailed(taskId);
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs
  ) {
    throw operationFailed(taskId);
  }
  await assertNoSymlinkAncestors(rootPath, gitPath, taskId);
  assertFingerprintWithinDeadline(budget, taskId);
}

async function assertNoSymlinkAncestors(
  rootPath: string,
  gitPath: string,
  taskId: string,
): Promise<void> {
  const segments = gitPath.split('/');
  let currentPath = rootPath;
  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment);
    let metadata;
    try {
      metadata = await lstat(currentPath);
    } catch {
      throw operationFailed(taskId);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw operationFailed(taskId);
    }
  }
}

async function hashFile(
  path: string,
  expected: BigIntStats,
  expectedByteLength: number,
  taskId: string,
  budget: FingerprintBudget,
): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(expected, opened)) {
      throw operationFailed(taskId);
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expectedByteLength) {
      assertFingerprintWithinDeadline(budget, taskId);
      const bytesToRead = Math.min(buffer.length, expectedByteLength - position);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead === 0) {
        throw operationFailed(taskId);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const completed = await handle.stat({ bigint: true });
    if (!sameFileIdentity(expected, completed)) {
      throw operationFailed(taskId);
    }
    return hash.digest();
  } catch (error) {
    if (error instanceof TaskWorktreeLifecycleError) {
      throw error;
    }
    throw operationFailed(taskId);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function reserveFingerprintBytes(budget: FingerprintBudget, size: bigint, taskId: string): number {
  if (size < 0n || size > BigInt(budget.remainingBytes)) {
    throw operationFailed(taskId);
  }
  const byteLength = Number(size);
  budget.remainingBytes -= byteLength;
  return byteLength;
}

function assertFingerprintWithinDeadline(budget: FingerprintBudget, taskId: string): void {
  if (performance.now() > budget.deadlineAt) {
    throw operationFailed(taskId);
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function boundChanges(changes: FullChanges): TaskReviewChanges {
  const uniquePaths = new Set([
    ...changes.committed,
    ...changes.conflicted,
    ...changes.staged,
    ...changes.unstaged,
    ...changes.untracked,
  ]);
  let remaining = maximumChangedPaths;
  const take = (paths: readonly string[]): readonly string[] => {
    const visible = Object.freeze(paths.slice(0, remaining));
    remaining -= visible.length;
    return visible;
  };
  const committed = take(changes.committed);
  const conflicted = take(changes.conflicted);
  const staged = take(changes.staged);
  const unstaged = take(changes.unstaged);
  const untracked = take(changes.untracked);
  const visibleEntries =
    committed.length + conflicted.length + staged.length + unstaged.length + untracked.length;
  const fullEntries =
    changes.committed.length +
    changes.conflicted.length +
    changes.staged.length +
    changes.unstaged.length +
    changes.untracked.length;

  return Object.freeze({
    committed,
    conflicted,
    staged,
    total: uniquePaths.size,
    truncated: visibleEntries < fullEntries,
    unstaged,
    untracked,
  });
}

function parseNulPaths(
  result: { readonly exitCode: number; readonly stdout: string },
  taskId: string,
): readonly string[] {
  if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith('\0'))) {
    throw operationFailed(taskId);
  }
  const paths = splitNulRecords(result.stdout);
  for (const path of paths) {
    assertSafeGitPath(path, taskId);
  }
  return Object.freeze([...new Set(paths)].sort(compareStrings));
}

function splitNulRecords(stdout: string): readonly string[] {
  return stdout.length === 0 ? [] : stdout.slice(0, -1).split('\0');
}

function splitFixedFields(
  record: string,
  separatorCount: number,
  taskId: string,
): readonly string[] {
  const fields: string[] = [];
  let fieldStart = 0;
  for (let index = 0; index < separatorCount; index += 1) {
    const separator = record.indexOf(' ', fieldStart);
    if (separator < 0) {
      throw operationFailed(taskId);
    }
    fields.push(record.slice(fieldStart, separator));
    fieldStart = separator + 1;
  }
  fields.push(record.slice(fieldStart));
  return fields;
}

interface WorktreeRecord {
  readonly branchRef: string | undefined;
  readonly headCommitId: string | undefined;
  readonly path: string;
}

function parseWorktreeRecords(stdout: string, taskId: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: { branchRef?: string; headCommitId?: string; path: string } | undefined;
  const finish = (): void => {
    if (current !== undefined) {
      records.push(
        Object.freeze({
          branchRef: current.branchRef,
          headCommitId: current.headCommitId,
          path: current.path,
        }),
      );
      current = undefined;
    }
  };

  for (const field of stdout.slice(0, -1).split('\0')) {
    if (field.length === 0) {
      finish();
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      finish();
      if (!isAbsolute(value)) {
        throw worktreeMismatch(taskId);
      }
      current = { path: normalize(value) };
      continue;
    }
    if (current === undefined) {
      throw worktreeMismatch(taskId);
    }
    if (key === 'HEAD' && isObjectId(value)) {
      current.headCommitId = value;
    } else if (key === 'branch' && value.startsWith('refs/heads/')) {
      current.branchRef = value;
    } else if (!['bare', 'detached', 'locked', 'prunable'].includes(key)) {
      throw worktreeMismatch(taskId);
    }
  }
  finish();
  return Object.freeze(records);
}

function assertSafeGitPath(path: string, taskId: string): void {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    isAbsolute(path) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw operationFailed(taskId);
  }
}

function resolveGitPath(rootPath: string, gitPath: string, taskId: string): string {
  assertSafeGitPath(gitPath, taskId);
  const candidate = normalize(join(rootPath, ...gitPath.split('/')));
  const relativePath = relative(rootPath, candidate);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw operationFailed(taskId);
  }
  return candidate;
}

function parseLine(
  result: { readonly exitCode: number; readonly stdout: string },
  taskId: string,
): string {
  if (result.exitCode !== 0 || !result.stdout.endsWith('\n')) {
    throw worktreeMismatch(taskId);
  }
  const value = removeFinalLineEnding(result.stdout);
  if (value.length === 0 || value.includes('\n') || value.includes('\r')) {
    throw worktreeMismatch(taskId);
  }
  return value;
}

function parseObjectId(
  result: { readonly exitCode: number; readonly stdout: string },
  taskId: string,
): string {
  const value = parseLine(result, taskId);
  if (!isObjectId(value)) {
    throw worktreeMismatch(taskId);
  }
  return value;
}

function addFrame(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  hash.update(Buffer.from(`${bytes.length}:`, 'ascii'));
  hash.update(bytes);
}

function sorted(values: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...values].sort(compareStrings));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createPathIdentity(path: string): string {
  const normalizedPath = normalize(path);
  return process.platform === 'win32'
    ? `win32:${normalizedPath.toLocaleLowerCase('en-US')}`
    : `posix:${normalizedPath}`;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function sameCapture(left: TaskReviewCodeState, right: TaskReviewCodeState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function gitOptions() {
  return { maxBuffer: maximumGitOutputBytes, timeout: gitTimeoutMs } as const;
}

function readTaskId(worktree: TaskWorktree): string {
  return worktree !== null && typeof worktree === 'object' && typeof worktree.taskId === 'string'
    ? worktree.taskId
    : '';
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
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

function getErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}

function worktreeMismatch(taskId: string): TaskWorktreeLifecycleError {
  return new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
}

function operationFailed(taskId: string): TaskWorktreeLifecycleError {
  return new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
}
