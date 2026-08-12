import { createHash } from 'node:crypto';
import { realpath, type Dirent } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import {
  TaskWorktreeLifecycleError,
  type GitTaskWorktreeLifecycle,
  type InspectGitTaskWorktreeInput,
  type TaskWorktree,
  type TaskWorktreeCleanupResult,
  type TaskWorktreeEnsureResult,
  type TaskWorktreeInspection,
  type TaskWorktreeRecord,
  type TaskWorktreeStatus,
} from '@agentterm/application';

import { GitCli, isGitVersionAtLeast, removeFinalLineEnding } from './git-cli';
import { GitCliRepositoryInspector } from './git-cli-repository-inspector';

const disabledHooksPath = '/dev/null';
const maximumGitOutput = 16 * 1024 * 1024;

interface RegisteredWorktree {
  readonly bare: boolean;
  readonly branchRef: string | undefined;
  readonly detached: boolean;
  readonly headCommitId: string | undefined;
  readonly locked: boolean;
  readonly path: string;
  readonly prunable: boolean;
}

type InspectedWorktree =
  | {
      readonly inspection: Extract<TaskWorktreeInspection, { readonly kind: 'missing' }>;
      readonly registered: undefined;
    }
  | {
      readonly inspection: Extract<TaskWorktreeInspection, { readonly kind: 'stale-registration' }>;
      readonly registered: RegisteredWorktree;
    }
  | {
      readonly inspection: Extract<TaskWorktreeInspection, { readonly kind: 'present' }>;
      readonly registered: RegisteredWorktree;
    };

export class GitCliTaskWorktreeLifecycle implements GitTaskWorktreeLifecycle {
  private readonly git: GitCli;
  private readonly inspector: GitCliRepositoryInspector;

  public constructor(
    private readonly configuredWorktreesRoot: string,
    configuredGitExecutable = 'git',
  ) {
    this.git = new GitCli(configuredGitExecutable);
    this.inspector = new GitCliRepositoryInspector(configuredGitExecutable);
  }

  public async inspect(input: InspectGitTaskWorktreeInput): Promise<TaskWorktreeInspection> {
    try {
      return (await this.inspectInternal(input)).inspection;
    } catch (error) {
      throw mapLifecycleError(error, input.taskId);
    }
  }

  public async ensure(worktree: TaskWorktree): Promise<TaskWorktreeEnsureResult> {
    try {
      let current = await this.inspectInternal({
        recordedWorktree: asRecord(worktree, 'PROVISIONING'),
        repositoryRootPath: worktree.repositoryRootPath,
        taskId: worktree.taskId,
      });

      if (current.inspection.kind === 'present') {
        return freezeEnsureResult('reused', current.inspection);
      }

      if (current.inspection.kind === 'stale-registration') {
        const registered = current.registered;

        if (registered === undefined) {
          throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', worktree.taskId);
        }

        if (current.inspection.status.isDirty) {
          throw new TaskWorktreeLifecycleError('DIRTY_WORKTREE', worktree.taskId, {
            recoveryPath: current.inspection.recoveryPath,
            status: current.inspection.status,
          });
        }

        await this.removeStaleRegistration(worktree, registered);
        current = await this.inspectInternal({
          recordedWorktree: asRecord(worktree, 'PROVISIONING'),
          repositoryRootPath: worktree.repositoryRootPath,
          taskId: worktree.taskId,
        });

        if (current.inspection.kind !== 'missing') {
          throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', worktree.taskId);
        }
      }

      const branchCommit = await this.readBranchCommit(
        worktree.repositoryRootPath,
        worktree.branchName,
        worktree.taskId,
      );

      if (branchCommit === undefined) {
        const verifiedBaseCommit = await this.resolveCommit(
          worktree.repositoryRootPath,
          worktree.baseCommitId,
          worktree.taskId,
        );

        if (verifiedBaseCommit !== worktree.baseCommitId) {
          throw new TaskWorktreeLifecycleError('METADATA_MISMATCH', worktree.taskId);
        }

        const branchResult = await this.git.run(
          worktree.repositoryRootPath,
          [
            '-c',
            `core.hooksPath=${disabledHooksPath}`,
            'branch',
            '--no-track',
            worktree.branchName,
            worktree.baseCommitId,
          ],
          { maxBuffer: maximumGitOutput, timeout: 30_000 },
        );

        if (
          branchResult.exitCode !== 0 &&
          (await this.readBranchCommit(
            worktree.repositoryRootPath,
            worktree.branchName,
            worktree.taskId,
          )) === undefined
        ) {
          throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', worktree.taskId);
        }
      }

      const addResult = await this.git.run(
        worktree.repositoryRootPath,
        [
          '-c',
          `core.hooksPath=${disabledHooksPath}`,
          'worktree',
          'add',
          '--no-guess-remote',
          worktree.worktreePath,
          worktree.branchName,
        ],
        { maxBuffer: maximumGitOutput, timeout: 120_000 },
      );

      current = await this.inspectInternal({
        recordedWorktree: asRecord(worktree, 'PROVISIONING'),
        repositoryRootPath: worktree.repositoryRootPath,
        taskId: worktree.taskId,
      });

      if (current.inspection.kind !== 'present') {
        throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', worktree.taskId);
      }

      return freezeEnsureResult(
        addResult.exitCode === 0 ? 'created' : 'reused',
        current.inspection,
      );
    } catch (error) {
      throw mapLifecycleError(error, worktree.taskId);
    }
  }

  public async cleanup(worktree: TaskWorktree): Promise<TaskWorktreeCleanupResult> {
    try {
      const current = await this.inspectInternal({
        recordedWorktree: asRecord(worktree, 'REMOVING'),
        repositoryRootPath: worktree.repositoryRootPath,
        taskId: worktree.taskId,
      });

      if (current.inspection.kind === 'missing') {
        return Object.freeze({ kind: 'already-missing', worktree: current.inspection.worktree });
      }

      const registered = current.registered;

      if (registered === undefined) {
        throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', worktree.taskId);
      }

      if (registered.locked) {
        throw new TaskWorktreeLifecycleError('LOCKED_WORKTREE', worktree.taskId);
      }

      if (
        (current.inspection.kind === 'present' ||
          current.inspection.kind === 'stale-registration') &&
        (current.inspection.status.isDirty || current.inspection.status.ignoredPaths.length > 0)
      ) {
        throw new TaskWorktreeLifecycleError('DIRTY_WORKTREE', worktree.taskId, {
          ...(current.inspection.kind === 'stale-registration'
            ? { recoveryPath: current.inspection.recoveryPath }
            : {}),
          status: current.inspection.status,
        });
      }

      const removeResult = await this.git.run(
        worktree.repositoryRootPath,
        ['-c', `core.hooksPath=${disabledHooksPath}`, 'worktree', 'remove', worktree.worktreePath],
        { maxBuffer: maximumGitOutput, timeout: 120_000 },
      );
      const verified = await this.inspectInternal({
        recordedWorktree: asRecord(worktree, 'REMOVING'),
        repositoryRootPath: worktree.repositoryRootPath,
        taskId: worktree.taskId,
      });

      if (removeResult.exitCode !== 0 || verified.inspection.kind !== 'missing') {
        throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', worktree.taskId);
      }

      if (
        (await this.readBranchCommit(
          worktree.repositoryRootPath,
          worktree.branchName,
          worktree.taskId,
        )) === undefined
      ) {
        throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', worktree.taskId);
      }

      return Object.freeze({ kind: 'removed', worktree: verified.inspection.worktree });
    } catch (error) {
      throw mapLifecycleError(error, worktree.taskId);
    }
  }

  private async inspectInternal(input: InspectGitTaskWorktreeInput): Promise<InspectedWorktree> {
    assertTaskId(input.taskId);
    const repositoryRootPath = await this.git.resolveWorkingTreeRoot(input.repositoryRootPath);
    const version = await this.git.version();

    if (!isGitVersionAtLeast(version, 2, 45)) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', input.taskId);
    }

    const worktreesRoot = await this.resolveManagedRoot(repositoryRootPath, input.taskId);
    const expected = createExpectedIdentity(repositoryRootPath, worktreesRoot, input.taskId);
    const registeredWorktrees = await this.listRegisteredWorktrees(
      repositoryRootPath,
      input.taskId,
    );
    const expectedBranchRef = `refs/heads/${expected.branchName}`;
    const pathMatches = registeredWorktrees.filter((candidate) =>
      samePath(candidate.path, expected.worktreePath),
    );
    const branchMatches = registeredWorktrees.filter(
      (candidate) => candidate.branchRef === expectedBranchRef,
    );

    if (pathMatches.length > 1 || branchMatches.length > 1) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', input.taskId);
    }

    const pathMatch = pathMatches[0];
    const branchMatch = branchMatches[0];

    if (branchMatch !== undefined && !samePath(branchMatch.path, expected.worktreePath)) {
      throw new TaskWorktreeLifecycleError('BRANCH_COLLISION', input.taskId);
    }

    if (pathMatch !== undefined && pathMatch.branchRef !== expectedBranchRef) {
      throw new TaskWorktreeLifecycleError('PATH_COLLISION', input.taskId);
    }

    let worktree: TaskWorktree;

    if (input.recordedWorktree !== undefined) {
      validateRecordedWorktree(input.recordedWorktree, expected, input.taskId);
      worktree = freezeWorktree(input.recordedWorktree);
    } else {
      const branchCommit = await this.readBranchCommit(
        repositoryRootPath,
        expected.branchName,
        input.taskId,
      );

      if (branchCommit !== undefined) {
        worktree = freezeWorktree({
          ...expected,
          baseCommitId: branchCommit,
          baseRefName: expectedBranchRef,
        });
      } else {
        const repository = await this.inspector.inspect(repositoryRootPath);

        if (
          repository.kind !== 'repository' ||
          repository.repository.suggestedBaseBranch === undefined
        ) {
          throw new TaskWorktreeLifecycleError('BASE_BRANCH_UNAVAILABLE', input.taskId);
        }

        const baseRefName = repository.repository.suggestedBaseBranch.refName;
        const baseCommitId = await this.resolveCommit(
          repositoryRootPath,
          baseRefName,
          input.taskId,
        );
        worktree = freezeWorktree({ ...expected, baseCommitId, baseRefName });
      }
    }

    if (pathMatch === undefined) {
      if (await pathExists(expected.worktreePath)) {
        throw new TaskWorktreeLifecycleError('PATH_COLLISION', input.taskId);
      }

      return Object.freeze({
        inspection: Object.freeze({ kind: 'missing', worktree }),
        registered: undefined,
      });
    }

    if (pathMatch.bare || pathMatch.detached) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', input.taskId);
    }

    if (pathMatch.prunable) {
      const branchCommit = await this.readBranchCommit(
        repositoryRootPath,
        expected.branchName,
        input.taskId,
      );

      if (
        (await pathExists(expected.worktreePath)) ||
        branchCommit === undefined ||
        pathMatch.headCommitId !== branchCommit
      ) {
        throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', input.taskId);
      }

      const recovery = await this.inspectStaleRecovery(
        repositoryRootPath,
        worktree,
        branchCommit,
        input.taskId,
      );

      return Object.freeze({
        inspection: Object.freeze({ kind: 'stale-registration', ...recovery, worktree }),
        registered: pathMatch,
      });
    }

    const canonicalWorktreePath = await resolveNativeRealPath(expected.worktreePath);

    if (
      !samePath(canonicalWorktreePath, expected.worktreePath) ||
      !isStrictlyInside(worktreesRoot, canonicalWorktreePath)
    ) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', input.taskId);
    }

    const repository = await this.inspector.inspect(canonicalWorktreePath);
    const [repositoryCommonDirectory, worktreeCommonDirectory] = await Promise.all([
      this.resolveCommonGitDirectory(repositoryRootPath, input.taskId),
      this.resolveCommonGitDirectory(canonicalWorktreePath, input.taskId),
    ]);

    if (
      repository.kind !== 'repository' ||
      repository.repository.head.kind !== 'attached' ||
      repository.repository.head.branchName !== expected.branchName ||
      pathMatch.headCommitId !== repository.repository.head.commitId ||
      !samePath(repositoryCommonDirectory, worktreeCommonDirectory) ||
      !samePath(repository.repository.rootPath, expected.worktreePath)
    ) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', input.taskId);
    }

    const ignoredPaths = await this.readIgnoredPaths(canonicalWorktreePath, input.taskId);
    const status: TaskWorktreeStatus = Object.freeze({
      ...repository.repository.status,
      ignoredPaths,
    });

    return Object.freeze({
      inspection: Object.freeze({
        headCommitId: repository.repository.head.commitId,
        kind: 'present',
        status,
        worktree,
      }),
      registered: pathMatch,
    });
  }

  private async resolveManagedRoot(repositoryRootPath: string, taskId: string): Promise<string> {
    if (
      this.configuredWorktreesRoot.trim().length === 0 ||
      this.configuredWorktreesRoot.includes('\0') ||
      !isAbsolute(this.configuredWorktreesRoot)
    ) {
      throw new TaskWorktreeLifecycleError('INVALID_WORKTREE_ROOT', taskId);
    }

    const configuredRoot = normalize(this.configuredWorktreesRoot);

    if (
      samePath(configuredRoot, repositoryRootPath) ||
      isStrictlyInside(repositoryRootPath, configuredRoot)
    ) {
      throw new TaskWorktreeLifecycleError('INVALID_WORKTREE_ROOT', taskId);
    }

    try {
      await mkdir(configuredRoot, { recursive: true });
      const metadata = await stat(configuredRoot);

      if (!metadata.isDirectory()) {
        throw new TaskWorktreeLifecycleError('INVALID_WORKTREE_ROOT', taskId);
      }

      const canonicalRoot = normalize(await resolveNativeRealPath(configuredRoot));

      if (
        samePath(canonicalRoot, repositoryRootPath) ||
        isStrictlyInside(repositoryRootPath, canonicalRoot)
      ) {
        throw new TaskWorktreeLifecycleError('INVALID_WORKTREE_ROOT', taskId);
      }

      return canonicalRoot;
    } catch (error) {
      if (error instanceof TaskWorktreeLifecycleError) {
        throw error;
      }

      throw new TaskWorktreeLifecycleError('INVALID_WORKTREE_ROOT', taskId, { cause: error });
    }
  }

  private async listRegisteredWorktrees(
    repositoryRootPath: string,
    taskId: string,
  ): Promise<readonly RegisteredWorktree[]> {
    const result = await this.git.run(
      repositoryRootPath,
      ['worktree', 'list', '--porcelain', '-z'],
      { maxBuffer: maximumGitOutput, timeout: 30_000 },
    );

    if (result.exitCode !== 0) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
    }

    return parseWorktreeList(result.stdout, taskId);
  }

  private async readBranchCommit(
    repositoryRootPath: string,
    branchName: string,
    taskId: string,
  ): Promise<string | undefined> {
    const result = await this.git.run(repositoryRootPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/heads/${branchName}^{commit}`,
    ]);

    if (result.exitCode === 1 && result.stdout.length === 0) {
      return undefined;
    }

    const commitId = removeFinalLineEnding(result.stdout);

    if (result.exitCode !== 0 || !result.stdout.endsWith('\n') || !isObjectId(commitId)) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
    }

    return commitId;
  }

  private async inspectStaleRecovery(
    repositoryRootPath: string,
    worktree: TaskWorktree,
    headCommitId: string,
    taskId: string,
  ): Promise<{
    readonly recoveryPath: string;
    readonly status: TaskWorktreeStatus;
  }> {
    const commonDirectory = await this.resolveCommonGitDirectory(repositoryRootPath, taskId);
    let administrativeRoot: string;

    try {
      administrativeRoot = await resolveNativeRealPath(join(commonDirectory, 'worktrees'));
    } catch (error) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId, { cause: error });
    }

    if (!isStrictlyInside(commonDirectory, administrativeRoot)) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
    }

    const expectedGitFile = join(worktree.worktreePath, '.git');
    const recoveryCandidates: string[] = [];
    let entries: Dirent<string>[];

    try {
      entries = await readdir(administrativeRoot, { withFileTypes: true });
    } catch (error) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId, { cause: error });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const candidate = await resolveNativeRealPath(join(administrativeRoot, entry.name));

        if (!isStrictlyInside(administrativeRoot, candidate)) {
          continue;
        }

        const gitDirectoryPointerPath = join(candidate, 'gitdir');
        const pointerMetadata = await lstat(gitDirectoryPointerPath);

        if (!pointerMetadata.isFile() || pointerMetadata.size > 32 * 1024) {
          continue;
        }

        const pointer = removeFinalLineEnding(
          await readFile(gitDirectoryPointerPath, { encoding: 'utf8' }),
        );

        if (isAbsolute(pointer) && samePath(pointer, expectedGitFile)) {
          recoveryCandidates.push(candidate);
        }
      } catch {
        // An unreadable candidate cannot be selected as the exact recovery record.
      }
    }

    if (recoveryCandidates.length !== 1) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
    }

    const recoveryPath = recoveryCandidates[0];

    if (recoveryPath === undefined) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
    }

    try {
      const indexMetadata = await lstat(join(recoveryPath, 'index'));

      if (!indexMetadata.isFile()) {
        throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
      }
    } catch (error) {
      if (error instanceof TaskWorktreeLifecycleError) {
        throw error;
      }

      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId, { cause: error });
    }

    const stagedPaths = await this.readStaleStagedPaths(
      repositoryRootPath,
      worktree.worktreePath,
      recoveryPath,
      headCommitId,
      taskId,
    );
    const status: TaskWorktreeStatus = Object.freeze({
      conflictedPaths: [],
      ignoredPaths: [],
      isDirty: stagedPaths.length > 0,
      stagedPaths,
      unstagedPaths: [],
      untrackedPaths: [],
    });

    return Object.freeze({ recoveryPath, status });
  }

  private async readStaleStagedPaths(
    repositoryRootPath: string,
    worktreePath: string,
    recoveryPath: string,
    headCommitId: string,
    taskId: string,
  ): Promise<readonly string[]> {
    const result = await this.git.run(
      repositoryRootPath,
      [
        '-c',
        'core.fsmonitor=false',
        `--git-dir=${recoveryPath}`,
        `--work-tree=${worktreePath}`,
        'diff-index',
        '--cached',
        '--name-only',
        '-z',
        '--no-ext-diff',
        '--no-renames',
        '--ignore-submodules=none',
        headCommitId,
        '--',
      ],
      { maxBuffer: maximumGitOutput, timeout: 30_000 },
    );

    if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith('\0'))) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
    }

    return Object.freeze(result.stdout.length === 0 ? [] : result.stdout.slice(0, -1).split('\0'));
  }

  private async removeStaleRegistration(
    worktree: TaskWorktree,
    registered: RegisteredWorktree,
  ): Promise<void> {
    if (registered.locked || !registered.prunable || (await pathExists(worktree.worktreePath))) {
      throw new TaskWorktreeLifecycleError(
        registered.locked ? 'LOCKED_WORKTREE' : 'WORKTREE_MISMATCH',
        worktree.taskId,
      );
    }

    const result = await this.git.run(
      worktree.repositoryRootPath,
      ['-c', `core.hooksPath=${disabledHooksPath}`, 'worktree', 'remove', worktree.worktreePath],
      { maxBuffer: maximumGitOutput, timeout: 120_000 },
    );

    if (result.exitCode !== 0) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', worktree.taskId);
    }
  }

  private async resolveCommit(
    repositoryRootPath: string,
    refName: string,
    taskId: string,
  ): Promise<string> {
    const result = await this.git.run(repositoryRootPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${refName}^{commit}`,
    ]);
    const commitId = removeFinalLineEnding(result.stdout);

    if (result.exitCode !== 0 || !result.stdout.endsWith('\n') || !isObjectId(commitId)) {
      throw new TaskWorktreeLifecycleError('BASE_BRANCH_UNAVAILABLE', taskId);
    }

    return commitId;
  }

  private async readIgnoredPaths(worktreePath: string, taskId: string): Promise<readonly string[]> {
    const result = await this.git.run(
      worktreePath,
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      { maxBuffer: maximumGitOutput, timeout: 30_000 },
    );

    if (result.exitCode !== 0 || (result.stdout.length > 0 && !result.stdout.endsWith('\0'))) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
    }

    return Object.freeze(result.stdout.length === 0 ? [] : result.stdout.slice(0, -1).split('\0'));
  }

  private async resolveCommonGitDirectory(repositoryPath: string, taskId: string): Promise<string> {
    const result = await this.git.run(repositoryPath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const commonDirectory = removeFinalLineEnding(result.stdout);

    if (
      result.exitCode !== 0 ||
      !result.stdout.endsWith('\n') ||
      commonDirectory.length === 0 ||
      !isAbsolute(commonDirectory)
    ) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId);
    }

    try {
      return await resolveNativeRealPath(commonDirectory);
    } catch (error) {
      throw new TaskWorktreeLifecycleError('WORKTREE_MISMATCH', taskId, { cause: error });
    }
  }
}

function createExpectedIdentity(
  repositoryRootPath: string,
  worktreesRoot: string,
  taskId: string,
): Omit<TaskWorktree, 'baseCommitId' | 'baseRefName'> {
  const hash = createHash('sha256')
    .update(createPathIdentity(repositoryRootPath))
    .update('\0')
    .update(taskId)
    .digest('hex');
  const branchName = `agentterm/task/${hash}`;
  const worktreePath = join(worktreesRoot, `task-${hash}`);

  return Object.freeze({
    branchName,
    pathIdentity: createPathIdentity(worktreePath),
    repositoryRootPath,
    taskId,
    worktreePath,
  });
}

function validateRecordedWorktree(
  recorded: TaskWorktreeRecord,
  expected: Omit<TaskWorktree, 'baseCommitId' | 'baseRefName'>,
  taskId: string,
): void {
  if (
    recorded.taskId !== expected.taskId ||
    recorded.branchName !== expected.branchName ||
    recorded.pathIdentity !== expected.pathIdentity ||
    !samePath(recorded.repositoryRootPath, expected.repositoryRootPath) ||
    !samePath(recorded.worktreePath, expected.worktreePath) ||
    recorded.baseRefName.trim().length === 0 ||
    !isObjectId(recorded.baseCommitId)
  ) {
    throw new TaskWorktreeLifecycleError('METADATA_MISMATCH', taskId);
  }
}

function parseWorktreeList(stdout: string, taskId: string): readonly RegisteredWorktree[] {
  if (stdout.length === 0 || !stdout.endsWith('\0')) {
    throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
  }

  const worktrees: RegisteredWorktree[] = [];
  let current: MutableRegisteredWorktree | undefined;

  const finishCurrent = (): void => {
    if (current === undefined) {
      return;
    }

    if (!isAbsolute(current.path)) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
    }

    worktrees.push(
      Object.freeze({
        bare: current.bare,
        branchRef: current.branchRef,
        detached: current.detached,
        headCommitId: current.headCommitId,
        locked: current.locked,
        path: normalize(current.path),
        prunable: current.prunable,
      }),
    );
    current = undefined;
  };

  for (const field of stdout.slice(0, -1).split('\0')) {
    if (field.length === 0) {
      finishCurrent();
      continue;
    }

    const separator = field.indexOf(' ');
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);

    if (key === 'worktree') {
      finishCurrent();

      if (value.length === 0) {
        throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
      }

      current = {
        bare: false,
        branchRef: undefined,
        detached: false,
        headCommitId: undefined,
        locked: false,
        path: value,
        prunable: false,
      };
      continue;
    }

    if (current === undefined) {
      throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
    }

    switch (key) {
      case 'HEAD':
        if (!isObjectId(value)) {
          throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
        }
        current.headCommitId = value;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'branch':
        if (!value.startsWith('refs/heads/') || value.length === 'refs/heads/'.length) {
          throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
        }
        current.branchRef = value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'locked':
        current.locked = true;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      default:
        throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
    }
  }

  finishCurrent();

  if (worktrees.length === 0) {
    throw new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId);
  }

  return Object.freeze(worktrees);
}

interface MutableRegisteredWorktree {
  bare: boolean;
  branchRef: string | undefined;
  detached: boolean;
  headCommitId: string | undefined;
  locked: boolean;
  path: string;
  prunable: boolean;
}

function freezeEnsureResult(
  kind: TaskWorktreeEnsureResult['kind'],
  inspection: Extract<TaskWorktreeInspection, { readonly kind: 'present' }>,
): TaskWorktreeEnsureResult {
  return Object.freeze({ kind, status: inspection.status, worktree: inspection.worktree });
}

function freezeWorktree(worktree: TaskWorktree): TaskWorktree {
  return Object.freeze({
    baseCommitId: worktree.baseCommitId,
    baseRefName: worktree.baseRefName,
    branchName: worktree.branchName,
    pathIdentity: worktree.pathIdentity,
    repositoryRootPath: worktree.repositoryRootPath,
    taskId: worktree.taskId,
    worktreePath: worktree.worktreePath,
  });
}

function asRecord(
  worktree: TaskWorktree,
  lifecycleState: TaskWorktreeRecord['lifecycleState'],
): TaskWorktreeRecord {
  return Object.freeze({ ...worktree, lifecycleState });
}

function assertTaskId(taskId: string): void {
  if (taskId.trim().length === 0 || taskId.includes('\0')) {
    throw new TaskWorktreeLifecycleError('METADATA_MISMATCH', taskId);
  }
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

function isStrictlyInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`)
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function resolveNativeRealPath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolvedPath) => {
      if (error === null) {
        resolve(normalize(resolvedPath));
      } else {
        reject(error);
      }
    });
  });
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value);
}

function getErrorCode(error: unknown): string | number | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'string' || typeof error.code === 'number' ? error.code : undefined;
}

function mapLifecycleError(error: unknown, taskId: string): TaskWorktreeLifecycleError {
  return error instanceof TaskWorktreeLifecycleError
    ? error
    : new TaskWorktreeLifecycleError('GIT_OPERATION_FAILED', taskId, { cause: error });
}
