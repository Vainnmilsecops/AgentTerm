import {
  GitRepositoryInspectionError,
  type GitBaseBranch,
  type GitHead,
  type GitRepositoryInspection,
  type GitRepositoryInspectionFailure,
  type GitRepositoryInspector,
  type GitWorkingTreeStatus,
} from '@agentterm/application';

import {
  GitCli,
  GitCliError,
  GitWorkingTreeAccessError,
  isGitVersionAtLeast,
  removeFinalLineEnding,
} from './git-cli';

interface GitRef {
  readonly objectId: string;
  readonly objectType: string;
  readonly refName: string;
  readonly symbolicTarget: string | undefined;
}

const baseCandidateRefNames = [
  'refs/heads/main',
  'refs/heads/master',
  'refs/remotes/origin/HEAD',
] as const;

export class GitCliRepositoryInspector implements GitRepositoryInspector {
  private readonly git: GitCli;

  public constructor(configuredGitExecutable = 'git') {
    this.git = new GitCli(configuredGitExecutable);
  }

  public async inspect(inputPath: string): Promise<GitRepositoryInspection> {
    let rootPath: string;

    try {
      rootPath = await this.git.resolveWorkingTreeRoot(inputPath);
    } catch (error) {
      return mapWorkingTreeResult(error, inputPath);
    }

    try {
      await this.assertSupportedVersion(inputPath);
      const branchResult = await this.git.run(rootPath, [
        'symbolic-ref',
        '--quiet',
        '--no-recurse',
        'HEAD',
      ]);
      const commitResult = await this.git.run(rootPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        'HEAD^{commit}',
      ]);
      const head = parseHead(branchResult, commitResult, inputPath);
      const refs: GitRef[] = [];

      for (const refName of baseCandidateRefNames) {
        const refResult = await this.git.run(rootPath, [
          'for-each-ref',
          '--count=1',
          '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(symref)',
          refName,
        ]);
        const ref = parseCandidateRef(refResult, refName, inputPath);

        if (ref !== undefined) {
          refs.push(ref);
        }
      }

      const statusResult = await this.git.run(
        rootPath,
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
        { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      );
      const status = parseStatus(statusResult, inputPath);

      return Object.freeze({
        kind: 'repository',
        repository: Object.freeze({
          head,
          rootPath,
          status,
          suggestedBaseBranch: selectBaseBranch(refs, head),
        }),
      });
    } catch (error) {
      throw mapInspectionError(error, inputPath);
    }
  }

  private async assertSupportedVersion(inputPath: string): Promise<void> {
    const version = await this.git.version();

    if (!isGitVersionAtLeast(version, 2, 45)) {
      throw new GitRepositoryInspectionError('GIT_VERSION_UNSUPPORTED', inputPath);
    }
  }
}

function parseHead(
  branchResult: { readonly exitCode: number; readonly stdout: string },
  commitResult: { readonly exitCode: number; readonly stdout: string },
  inputPath: string,
): GitHead {
  if (![0, 1].includes(branchResult.exitCode) || ![0, 1].includes(commitResult.exitCode)) {
    throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
  }

  const branchName =
    branchResult.exitCode === 0 ? parseBranchName(branchResult.stdout, inputPath) : undefined;
  const commitId =
    commitResult.exitCode === 0 ? parseObjectId(commitResult.stdout, inputPath) : undefined;

  if (branchName !== undefined && commitId !== undefined) {
    return Object.freeze({ branchName, commitId, kind: 'attached' });
  }

  if (branchName !== undefined && commitId === undefined) {
    return Object.freeze({ branchName, kind: 'unborn' });
  }

  if (branchName === undefined && commitId !== undefined) {
    return Object.freeze({ commitId, kind: 'detached' });
  }

  throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
}

function parseBranchName(stdout: string, inputPath: string): string {
  const refName = removeFinalLineEnding(stdout);
  const prefix = 'refs/heads/';

  if (!stdout.endsWith('\n') || !refName.startsWith(prefix) || refName.length === prefix.length) {
    throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
  }

  return refName.slice(prefix.length);
}

function parseObjectId(stdout: string, inputPath: string): string {
  const objectId = removeFinalLineEnding(stdout);

  if (!stdout.endsWith('\n') || !/^[0-9a-f]+$/u.test(objectId)) {
    throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
  }

  return objectId;
}

function parseRefs(
  result: { readonly exitCode: number; readonly stdout: string },
  inputPath: string,
): readonly GitRef[] {
  if (result.exitCode !== 0) {
    throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
  }

  if (result.stdout.length === 0) {
    return Object.freeze([]);
  }

  if (!result.stdout.endsWith('\n')) {
    throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
  }

  const records = removeFinalLineEnding(result.stdout).split('\n');
  const refs = records.map((record) => {
    const [refName, objectId, objectType, symbolicTarget, ...extraFields] = record.split('\0');

    if (
      refName === undefined ||
      refName.length === 0 ||
      objectId === undefined ||
      !/^[0-9a-f]+$/u.test(objectId) ||
      objectType === undefined ||
      objectType.length === 0 ||
      symbolicTarget === undefined ||
      extraFields.length > 0
    ) {
      throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
    }

    return Object.freeze({
      objectId,
      objectType,
      refName,
      symbolicTarget: symbolicTarget.length === 0 ? undefined : symbolicTarget,
    });
  });

  return Object.freeze(refs);
}

function parseCandidateRef(
  result: { readonly exitCode: number; readonly stdout: string },
  expectedRefName: string,
  inputPath: string,
): GitRef | undefined {
  return parseRefs(result, inputPath).find((ref) => ref.refName === expectedRefName);
}

function selectBaseBranch(refs: readonly GitRef[], head: GitHead): GitBaseBranch | undefined {
  const refsByName = new Map(refs.map((ref) => [ref.refName, ref]));
  const remoteHead = refsByName.get('refs/remotes/origin/HEAD');

  if (
    remoteHead?.objectType === 'commit' &&
    remoteHead.symbolicTarget?.startsWith('refs/remotes/origin/') === true &&
    remoteHead.symbolicTarget !== 'refs/remotes/origin/HEAD'
  ) {
    return createBaseBranch(
      remoteHead.symbolicTarget.slice('refs/remotes/'.length),
      remoteHead.symbolicTarget,
      'remote-head',
    );
  }

  for (const [name, source] of [
    ['main', 'local-main'],
    ['master', 'local-master'],
  ] as const) {
    const refName = `refs/heads/${name}`;
    const ref = refsByName.get(refName);

    if (ref?.objectType === 'commit') {
      return createBaseBranch(name, refName, source);
    }
  }

  return head.kind === 'attached'
    ? createBaseBranch(head.branchName, `refs/heads/${head.branchName}`, 'current-branch')
    : undefined;
}

function createBaseBranch(
  name: string,
  refName: string,
  source: GitBaseBranch['source'],
): GitBaseBranch {
  return Object.freeze({ name, refName, source });
}

function parseStatus(
  result: { readonly exitCode: number; readonly stdout: string },
  inputPath: string,
): GitWorkingTreeStatus {
  if (result.exitCode !== 0) {
    throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
  }

  const stagedPaths = new Set<string>();
  const unstagedPaths = new Set<string>();
  const untrackedPaths = new Set<string>();
  const conflictedPaths = new Set<string>();

  if (result.stdout.length > 0) {
    if (!result.stdout.endsWith('\0')) {
      throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
    }

    for (const record of result.stdout.slice(0, -1).split('\0')) {
      if (record.startsWith('# ')) {
        continue;
      }

      if (record.startsWith('1 ')) {
        const fields = splitFixedFields(record, 8, inputPath);
        const statusCode = fields[1];
        const path = fields[8];

        if (
          statusCode === undefined ||
          !/^[.MTAD]{2}$/u.test(statusCode) ||
          path === undefined ||
          path.length === 0
        ) {
          throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
        }

        if (statusCode[0] !== '.') {
          stagedPaths.add(path);
        }

        if (statusCode[1] !== '.') {
          unstagedPaths.add(path);
        }

        continue;
      }

      if (record.startsWith('u ')) {
        const fields = splitFixedFields(record, 10, inputPath);
        const statusCode = fields[1];
        const path = fields[10];

        if (
          statusCode === undefined ||
          !/^[ADU]{2}$/u.test(statusCode) ||
          path === undefined ||
          path.length === 0
        ) {
          throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
        }

        conflictedPaths.add(path);
        continue;
      }

      if (record.startsWith('? ') && record.length > 2) {
        untrackedPaths.add(record.slice(2));
        continue;
      }

      throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
    }
  }

  const frozenStagedPaths = Object.freeze([...stagedPaths]);
  const frozenUnstagedPaths = Object.freeze([...unstagedPaths]);
  const frozenUntrackedPaths = Object.freeze([...untrackedPaths]);
  const frozenConflictedPaths = Object.freeze([...conflictedPaths]);

  return Object.freeze({
    conflictedPaths: frozenConflictedPaths,
    isDirty:
      frozenStagedPaths.length > 0 ||
      frozenUnstagedPaths.length > 0 ||
      frozenUntrackedPaths.length > 0 ||
      frozenConflictedPaths.length > 0,
    stagedPaths: frozenStagedPaths,
    unstagedPaths: frozenUnstagedPaths,
    untrackedPaths: frozenUntrackedPaths,
  });
}

function splitFixedFields(
  record: string,
  separatorCount: number,
  inputPath: string,
): readonly string[] {
  const fields: string[] = [];
  let fieldStart = 0;

  for (let index = 0; index < separatorCount; index += 1) {
    const separator = record.indexOf(' ', fieldStart);

    if (separator < 0) {
      throw new GitRepositoryInspectionError('GIT_INSPECTION_FAILED', inputPath);
    }

    fields.push(record.slice(fieldStart, separator));
    fieldStart = separator + 1;
  }

  fields.push(record.slice(fieldStart));
  return fields;
}

function mapWorkingTreeResult(error: unknown, inputPath: string): GitRepositoryInspection {
  if (error instanceof GitWorkingTreeAccessError && error.reason === 'NOT_WORKING_TREE') {
    return Object.freeze({ kind: 'not-working-tree' });
  }

  throw mapInspectionError(error, inputPath);
}

function mapInspectionError(error: unknown, inputPath: string): GitRepositoryInspectionError {
  if (error instanceof GitRepositoryInspectionError) {
    return error;
  }

  if (error instanceof GitWorkingTreeAccessError && error.reason !== 'NOT_WORKING_TREE') {
    return new GitRepositoryInspectionError(error.reason, inputPath);
  }

  const reason: GitRepositoryInspectionFailure =
    error instanceof GitCliError && error.reason === 'NOT_AVAILABLE'
      ? 'GIT_NOT_AVAILABLE'
      : 'GIT_INSPECTION_FAILED';
  return new GitRepositoryInspectionError(reason, inputPath);
}
