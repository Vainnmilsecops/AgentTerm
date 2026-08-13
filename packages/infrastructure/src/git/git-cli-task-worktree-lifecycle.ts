import { createHash } from 'node:crypto';
import { realpath, type Dirent } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import {
  TaskChangeInspectionError,
  TaskWorktreeLifecycleError,
  type GitTaskWorktreeLifecycle,
  type InspectGitTaskWorktreeInput,
  type TaskChangeArea,
  type TaskChangeInspector,
  type TaskChangeSet,
  type TaskFileChange,
  type TaskFileChangeKind,
  type TaskFileDiff,
  type TaskFileDiffRequest,
  type TaskWorktree,
  type TaskWorktreeCleanupResult,
  type TaskWorktreeEnsureResult,
  type TaskWorktreeInspection,
  type TaskWorktreeRecord,
  type TaskWorktreeStatus,
} from '@agentterm/application';

import { GitCli, GitCliError, isGitVersionAtLeast, removeFinalLineEnding } from './git-cli';
import { GitCliRepositoryInspector } from './git-cli-repository-inspector';

const disabledHooksPath = '/dev/null';
const maximumGitOutput = 16 * 1024 * 1024;
const maximumListedFiles = 500;
const maximumPatchOutput = 128 * 1024;
const maximumPatchLineChanges = 2_000;

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

export class GitCliTaskWorktreeLifecycle implements GitTaskWorktreeLifecycle, TaskChangeInspector {
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

  public async listChanges(worktree: TaskWorktreeRecord): Promise<TaskChangeSet> {
    try {
      const worktreePath = await this.resolveVerifiedChangeWorktree(worktree);
      const changes = await this.readChanges(worktreePath, worktree.baseCommitId, worktree.taskId);
      const changedPaths = [...new Set(changes.map(({ path }) => path))];
      const visiblePaths = new Set(changedPaths.slice(0, maximumListedFiles));
      const visibleChanges = changes.filter(({ path }) => visiblePaths.has(path));

      return Object.freeze({
        files: Object.freeze(visibleChanges),
        totalFiles: changedPaths.length,
        truncated: visiblePaths.size < changedPaths.length,
      });
    } catch (error) {
      throw mapChangeInspectionError(error, worktree.taskId);
    }
  }

  public async getFileDiff(
    worktree: TaskWorktreeRecord,
    request: TaskFileDiffRequest,
  ): Promise<TaskFileDiff> {
    try {
      const worktreePath = await this.resolveVerifiedChangeWorktree(worktree);
      const changes = await this.readChanges(worktreePath, worktree.baseCommitId, worktree.taskId);
      const selected = changes.find((change) => sameChangeIdentity(change, request));

      if (selected === undefined) {
        throw new TaskChangeInspectionError('CHANGE_NOT_FOUND', worktree.taskId);
      }

      if (selected.area === 'CONFLICTED') {
        return freezeFileDiff(selected, undefined, undefined, undefined, 'UNSUPPORTED');
      }

      if (selected.area === 'UNTRACKED') {
        const support = await inspectUntrackedFile(worktreePath, selected.path);

        if (support === 'UNSUPPORTED') {
          return freezeFileDiff(selected, undefined, undefined, undefined, 'UNSUPPORTED');
        }

        if (support === 'TOO_LARGE') {
          return freezeFileDiff(selected, undefined, undefined, undefined, 'TOO_LARGE');
        }
      }

      const diffArguments = createDiffArguments(selected, true, worktree.baseCommitId);
      const statResult = await this.git.run(worktreePath, diffArguments, {
        maxBuffer: maximumPatchOutput,
        timeout: 30_000,
      });
      assertDiffExitCode(statResult.exitCode, selected, worktree.taskId);
      const statistics = parseNumstat(statResult.stdout, worktree.taskId);

      if (statistics.binary) {
        return freezeFileDiff(selected, undefined, undefined, true, 'BINARY');
      }

      if (statistics.additions + statistics.deletions > maximumPatchLineChanges) {
        return freezeFileDiff(
          selected,
          statistics.additions,
          statistics.deletions,
          false,
          'TOO_LARGE',
        );
      }

      let patchResult: Awaited<ReturnType<GitCli['run']>>;

      try {
        patchResult = await this.git.run(
          worktreePath,
          createDiffArguments(selected, false, worktree.baseCommitId),
          {
            maxBuffer: maximumPatchOutput,
            timeout: 30_000,
          },
        );
      } catch (error) {
        if (error instanceof GitCliError && error.reason === 'OUTPUT_LIMIT') {
          return freezeFileDiff(
            selected,
            statistics.additions,
            statistics.deletions,
            false,
            'TOO_LARGE',
          );
        }

        throw error;
      }

      assertDiffExitCode(patchResult.exitCode, selected, worktree.taskId);
      return freezeFileDiff(
        selected,
        statistics.additions,
        statistics.deletions,
        false,
        undefined,
        patchResult.stdout,
      );
    } catch (error) {
      throw mapChangeInspectionError(error, worktree.taskId);
    }
  }

  private async resolveVerifiedChangeWorktree(worktree: TaskWorktreeRecord): Promise<string> {
    const current = await this.inspectInternal({
      recordedWorktree: worktree,
      repositoryRootPath: worktree.repositoryRootPath,
      taskId: worktree.taskId,
    });

    if (current.inspection.kind !== 'present') {
      throw new TaskChangeInspectionError('WORKTREE_NOT_READY', worktree.taskId);
    }

    return current.inspection.worktree.worktreePath;
  }

  private async readChanges(
    worktreePath: string,
    baseCommitId: string,
    taskId: string,
  ): Promise<readonly TaskFileChange[]> {
    const [statusResult, committedResult] = await Promise.all([
      this.git.run(
        worktreePath,
        [
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
          '--find-renames',
          '--no-ahead-behind',
          '--ignore-submodules=none',
        ],
        { maxBuffer: maximumGitOutput, timeout: 30_000 },
      ),
      this.git.run(
        worktreePath,
        [
          '-c',
          'core.fsmonitor=false',
          'diff',
          '--name-status',
          '-z',
          '--find-renames',
          '--no-ext-diff',
          '--no-textconv',
          baseCommitId,
          'HEAD',
          '--',
        ],
        { maxBuffer: maximumGitOutput, timeout: 30_000 },
      ),
    ]);

    if (statusResult.exitCode !== 0 || committedResult.exitCode !== 0) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }

    return Object.freeze([
      ...parseCommittedChanges(committedResult.stdout, taskId),
      ...parseChanges(statusResult.stdout, taskId),
    ]);
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

const changeAreaOrder: Readonly<Record<TaskChangeArea, number>> = Object.freeze({
  COMMITTED: 0,
  CONFLICTED: 3,
  STAGED: 1,
  UNSTAGED: 2,
  UNTRACKED: 4,
});

function parseCommittedChanges(stdout: string, taskId: string): readonly TaskFileChange[] {
  if (stdout.length > 0 && !stdout.endsWith('\0')) {
    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }

  const records = stdout.length === 0 ? [] : stdout.slice(0, -1).split('\0');
  const changes: TaskFileChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    const kind = mapCommittedChangeKind(status);
    const firstPath = records[index + 1];

    if (kind === undefined || firstPath === undefined) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }

    assertSafeChangePath(firstPath, taskId);
    index += 1;

    if (kind === 'RENAMED' || kind === 'COPIED') {
      const path = records[index + 1];
      assertSafeChangePath(path, taskId);
      changes.push(freezeChange('COMMITTED', kind, path, firstPath));
      index += 1;
    } else {
      changes.push(freezeChange('COMMITTED', kind, firstPath));
    }
  }

  return Object.freeze(changes);
}

function mapCommittedChangeKind(status: string | undefined): TaskFileChangeKind | undefined {
  if (status === undefined || !/^[ACDMRTUXB](?:\d{1,3})?$/u.test(status)) {
    return undefined;
  }

  return mapChangeKind(status[0]);
}

function parseChanges(stdout: string, taskId: string): readonly TaskFileChange[] {
  if (stdout.length > 0 && !stdout.endsWith('\0')) {
    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }

  const records = stdout.length === 0 ? [] : stdout.slice(0, -1).split('\0');
  const changes: TaskFileChange[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    if (record === undefined) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }

    if (record.startsWith('1 ')) {
      const fields = splitChangeFields(record, 8, taskId);
      appendTrackedChanges(changes, fields[1], fields[8], undefined, taskId);
      continue;
    }

    if (record.startsWith('2 ')) {
      const fields = splitChangeFields(record, 9, taskId);
      const previousPath = records[index + 1];

      if (previousPath === undefined) {
        throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
      }

      index += 1;
      assertSafeChangePath(previousPath, taskId);
      appendTrackedChanges(changes, fields[1], fields[9], previousPath, taskId);
      continue;
    }

    if (record.startsWith('u ')) {
      const fields = splitChangeFields(record, 10, taskId);
      const path = fields[10];
      assertSafeChangePath(path, taskId);
      changes.push(freezeChange('CONFLICTED', 'UNMERGED', path));
      continue;
    }

    if (record.startsWith('? ')) {
      const path = record.slice(2);
      assertSafeChangePath(path, taskId);
      changes.push(freezeChange('UNTRACKED', 'UNTRACKED', path));
      continue;
    }

    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }

  return Object.freeze(
    changes.sort(
      (left, right) =>
        changeAreaOrder[left.area]! - changeAreaOrder[right.area]! ||
        left.path.localeCompare(right.path, 'en-US') ||
        (left.previousPath ?? '').localeCompare(right.previousPath ?? '', 'en-US'),
    ),
  );
}

function appendTrackedChanges(
  changes: TaskFileChange[],
  statusCode: string | undefined,
  path: string | undefined,
  previousPath: string | undefined,
  taskId: string,
): void {
  if (statusCode === undefined || !/^[.MTADRCU]{2}$/u.test(statusCode)) {
    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }

  assertSafeChangePath(path, taskId);
  const stagedKind = mapChangeKind(statusCode[0]);
  const unstagedKind = mapChangeKind(statusCode[1]);

  if (stagedKind !== undefined) {
    changes.push(
      freezeChange(
        'STAGED',
        stagedKind,
        path,
        stagedKind === 'RENAMED' || stagedKind === 'COPIED' ? previousPath : undefined,
      ),
    );
  }

  if (unstagedKind !== undefined) {
    changes.push(
      freezeChange(
        'UNSTAGED',
        unstagedKind,
        path,
        unstagedKind === 'RENAMED' || unstagedKind === 'COPIED' ? previousPath : undefined,
      ),
    );
  }
}

function mapChangeKind(status: string | undefined): TaskFileChangeKind | undefined {
  switch (status) {
    case '.':
      return undefined;
    case 'A':
      return 'ADDED';
    case 'C':
      return 'COPIED';
    case 'D':
      return 'DELETED';
    case 'M':
    case 'T':
    case 'B':
    case 'X':
      return 'MODIFIED';
    case 'R':
      return 'RENAMED';
    case 'U':
      return 'UNMERGED';
    default:
      return undefined;
  }
}

function freezeChange(
  area: TaskChangeArea,
  kind: TaskFileChangeKind,
  path: string,
  previousPath?: string,
): TaskFileChange {
  return Object.freeze({
    area,
    kind,
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
  });
}

function splitChangeFields(
  record: string,
  separatorCount: number,
  taskId: string,
): readonly string[] {
  const fields: string[] = [];
  let fieldStart = 0;

  for (let index = 0; index < separatorCount; index += 1) {
    const separator = record.indexOf(' ', fieldStart);

    if (separator < 0) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }

    fields.push(record.slice(fieldStart, separator));
    fieldStart = separator + 1;
  }

  fields.push(record.slice(fieldStart));
  return fields;
}

function assertSafeChangePath(path: string | undefined, taskId: string): asserts path is string {
  if (
    path === undefined ||
    path.length === 0 ||
    path.length > 32_768 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-z]:/iu.test(path) ||
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }
}

function sameChangeIdentity(change: TaskFileChange, request: TaskFileDiffRequest): boolean {
  return (
    change.area === request.area &&
    change.path === request.path &&
    change.previousPath === request.previousPath
  );
}

async function inspectUntrackedFile(
  worktreePath: string,
  path: string,
): Promise<'SUPPORTED' | 'TOO_LARGE' | 'UNSUPPORTED'> {
  const segments = path.split('/');
  let candidate = worktreePath;

  try {
    for (const [index, segment] of segments.entries()) {
      candidate = join(candidate, segment);
      const metadata = await lstat(candidate);

      if (metadata.isSymbolicLink()) {
        return 'UNSUPPORTED';
      }

      if (index < segments.length - 1 ? !metadata.isDirectory() : !metadata.isFile()) {
        return 'UNSUPPORTED';
      }

      if (index === segments.length - 1 && metadata.size > maximumPatchOutput) {
        return 'TOO_LARGE';
      }
    }
  } catch {
    return 'UNSUPPORTED';
  }

  return 'SUPPORTED';
}

function createDiffArguments(
  change: TaskFileChange,
  numstat: boolean,
  baseCommitId: string,
): readonly string[] {
  const commonArguments = [
    '-c',
    'core.fsmonitor=false',
    'diff',
    ...(change.area === 'UNTRACKED' ? ['--no-index', '--no-renames'] : ['--find-renames']),
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    ...(change.area === 'STAGED' ? ['--cached'] : []),
    ...(numstat ? ['--numstat', '-z'] : ['--unified=3', '--src-prefix=a/', '--dst-prefix=b/']),
    ...(change.area === 'COMMITTED' ? [baseCommitId, 'HEAD'] : []),
    '--',
  ];

  if (change.area === 'UNTRACKED') {
    return [...commonArguments, '/dev/null', change.path];
  }

  return [
    ...commonArguments,
    ...(change.previousPath === undefined ? [] : [change.previousPath]),
    change.path,
  ];
}

function assertDiffExitCode(exitCode: number, change: TaskFileChange, taskId: string): void {
  const expectedExitCode = change.area === 'UNTRACKED' ? 1 : 0;

  if (exitCode !== expectedExitCode) {
    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }
}

function parseNumstat(
  stdout: string,
  taskId: string,
): { readonly additions: number; readonly binary: boolean; readonly deletions: number } {
  if (stdout.length === 0 || !stdout.endsWith('\0')) {
    throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
  }

  const records = stdout.slice(0, -1).split('\0');
  let additions = 0;
  let deletions = 0;
  let binary = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const match = record === undefined ? null : /^([^\t]+)\t([^\t]+)\t(.*)$/u.exec(record);

    if (match === null) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }

    if (match[3] === '') {
      if (records[index + 1] === undefined || records[index + 2] === undefined) {
        throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
      }

      index += 2;
    }

    if (match[1] === '-' && match[2] === '-') {
      binary = true;
      continue;
    }

    const recordAdditions = Number(match[1]);
    const recordDeletions = Number(match[2]);

    if (
      !Number.isSafeInteger(recordAdditions) ||
      recordAdditions < 0 ||
      !Number.isSafeInteger(recordDeletions) ||
      recordDeletions < 0
    ) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }

    additions += recordAdditions;
    deletions += recordDeletions;

    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
      throw new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId);
    }
  }

  return Object.freeze({ additions, binary, deletions });
}

function freezeFileDiff(
  change: TaskFileChange,
  additions: number | undefined,
  deletions: number | undefined,
  binary: boolean | undefined,
  omittedReason: TaskFileDiff['omittedReason'],
  patch?: string,
): TaskFileDiff {
  return Object.freeze({
    ...change,
    additions,
    binary,
    deletions,
    ...(omittedReason === undefined ? {} : { omittedReason }),
    patch: patch === undefined ? undefined : Object.freeze({ text: patch, truncated: false }),
  });
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

function mapChangeInspectionError(error: unknown, taskId: string): TaskChangeInspectionError {
  return error instanceof TaskChangeInspectionError
    ? error
    : new TaskChangeInspectionError('GIT_INSPECTION_FAILED', taskId, { cause: error });
}
