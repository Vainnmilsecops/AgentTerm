import { realpath } from 'node:fs/promises';
import { normalize } from 'node:path';

import {
  type CreatePullRequestRequest,
  type PullRequestBranchInspection,
  type PullRequestIntegration,
  TaskPullRequestError,
  type TaskPullRequest,
  type TaskWorktreeRecord,
} from '@agentterm/application';

import { GitCli, isGitVersionAtLeast, removeFinalLineEnding } from './git-cli';
import { GitHubCli } from './github-cli';

const maximumGitOutput = 1024 * 1024;
const maximumPullRequestPages = 10;
const pullRequestsPerPage = 100;

interface GitHubRepository {
  readonly name: string;
  readonly owner: string;
}

interface GitClient {
  readonly resolveWorkingTreeRoot: GitCli['resolveWorkingTreeRoot'];
  readonly run: GitCli['run'];
  readonly version: GitCli['version'];
}

interface GitHubClient {
  isAvailable(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  requestJson(
    method: 'GET' | 'PATCH' | 'POST',
    path: string,
    input?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

export interface GitHubPullRequestAdapterOverrides {
  readonly git?: GitClient;
  readonly github?: GitHubClient;
}

export class GitHubPullRequestAdapter implements PullRequestIntegration {
  private readonly git: GitClient;
  private readonly github: GitHubClient;

  public constructor(
    configuredGitExecutable = 'git',
    configuredGithubExecutable = 'gh',
    overrides: GitHubPullRequestAdapterOverrides = {},
  ) {
    this.git = overrides.git ?? new GitCli(configuredGitExecutable);
    this.github = overrides.github ?? new GitHubCli(configuredGithubExecutable);
  }

  public async inspect(worktree: TaskWorktreeRecord): Promise<PullRequestBranchInspection> {
    try {
      return await this.inspectReadyBranch(worktree);
    } catch {
      return blocked('INSPECTION_FAILED');
    }
  }

  public async push(worktree: TaskWorktreeRecord): Promise<PullRequestBranchInspection> {
    const current = await this.inspect(worktree);
    if (current.kind === 'blocked') {
      throw new TaskPullRequestError('BRANCH_NOT_READY', worktree.taskId);
    }
    if (current.remoteHeadCommitId === current.headCommitId) return current;
    try {
      const result = await this.git.run(
        worktree.worktreePath,
        [
          'push',
          '--porcelain',
          '--no-verify',
          '--no-follow-tags',
          '--signed=false',
          '--recurse-submodules=no',
          '--',
          current.remoteName,
          `${current.headCommitId}:refs/heads/${current.headBranch}`,
        ],
        { maxBuffer: maximumGitOutput, timeout: 120_000 },
      );
      if (result.exitCode !== 0) throw new Error('Git push failed.');
      const refreshed = await this.inspect(worktree);
      if (
        refreshed.kind === 'blocked' ||
        refreshed.repositoryOwner !== current.repositoryOwner ||
        refreshed.repositoryName !== current.repositoryName ||
        refreshed.baseBranch !== current.baseBranch ||
        refreshed.headBranch !== current.headBranch ||
        refreshed.headCommitId !== current.headCommitId ||
        refreshed.remoteHeadCommitId !== current.headCommitId
      ) {
        throw new Error('The pushed branch could not be verified.');
      }
      return refreshed;
    } catch (error) {
      if (error instanceof TaskPullRequestError) throw error;
      throw new TaskPullRequestError('PUSH_FAILED', worktree.taskId, { cause: error });
    }
  }

  public async createOrRefresh(
    worktree: TaskWorktreeRecord,
    request: CreatePullRequestRequest,
  ): Promise<TaskPullRequest> {
    try {
      const branch = await this.inspect(worktree);
      if (
        branch.kind === 'blocked' ||
        !branch.githubCliAvailable ||
        branch.remoteHeadCommitId !== branch.headCommitId
      ) {
        throw new TaskPullRequestError('BRANCH_NOT_READY', worktree.taskId);
      }
      if (!branch.githubAuthenticationAvailable) {
        throw new TaskPullRequestError('BRANCH_NOT_READY', worktree.taskId);
      }
      const repositoryPath = `/repos/${branch.repositoryOwner}/${branch.repositoryName}`;
      const remoteHead = readGithubReferenceHead(
        await this.github.requestJson(
          'GET',
          `${repositoryPath}/git/ref/heads/${encodeGithubRefPath(branch.headBranch)}`,
        ),
      );
      if (remoteHead !== branch.headCommitId) {
        throw new TaskPullRequestError('BRANCH_NOT_READY', worktree.taskId);
      }
      const candidates: TaskPullRequest[] = [];
      let complete = false;
      for (let page = 1; page <= maximumPullRequestPages; page += 1) {
        const query =
          `${repositoryPath}/pulls?state=all&head=` +
          `${encodeURIComponent(`${branch.repositoryOwner}:${branch.headBranch}`)}` +
          `&base=${encodeURIComponent(branch.baseBranch)}` +
          `&per_page=${String(pullRequestsPerPage)}&page=${String(page)}`;
        const response = await this.github.requestJson('GET', query);
        if (!Array.isArray(response)) {
          throw new Error('The GitHub Pull Request list is invalid.');
        }
        candidates.push(...mapPullRequestList(response, worktree.taskId, branch));
        if (response.length < pullRequestsPerPage) {
          complete = true;
          break;
        }
      }
      if (!complete) throw new Error('The GitHub Pull Request list exceeds its safety bound.');
      const existing = selectSuitablePullRequest(candidates);
      if (existing?.status === 'OPEN' || existing?.status === 'MERGED') return existing;
      const response =
        existing?.status === 'CLOSED'
          ? await this.github.requestJson(
              'PATCH',
              `${repositoryPath}/pulls/${String(existing.number)}`,
              { state: 'open' },
            )
          : await this.github.requestJson('POST', `${repositoryPath}/pulls`, {
              base: branch.baseBranch,
              body: request.body,
              head: branch.headBranch,
              title: request.title,
            });
      return mapPullRequest(response, worktree.taskId, branch);
    } catch (error) {
      if (error instanceof TaskPullRequestError && error.reason === 'BRANCH_NOT_READY') throw error;
      throw new TaskPullRequestError('CREATE_FAILED', worktree.taskId, { cause: error });
    }
  }

  private async inspectReadyBranch(
    worktree: TaskWorktreeRecord,
  ): Promise<PullRequestBranchInspection> {
    if (worktree.lifecycleState !== 'PRESENT') return blocked('INSPECTION_FAILED');
    const [worktreeRoot, recordedRoot] = await Promise.all([
      this.git.resolveWorkingTreeRoot(worktree.worktreePath),
      realpath(worktree.worktreePath),
    ]);
    if (!samePath(worktreeRoot, recordedRoot)) return blocked('INSPECTION_FAILED');
    const version = await this.git.version();
    if (!isGitVersionAtLeast(version, 2, 45)) return blocked('INSPECTION_FAILED');

    const [worktreeCommonDirectory, projectCommonDirectory] = await Promise.all([
      this.readAbsoluteCommonDirectory(worktreeRoot),
      this.readAbsoluteCommonDirectory(worktree.repositoryRootPath),
    ]);
    if (!samePath(worktreeCommonDirectory, projectCommonDirectory)) {
      return blocked('INSPECTION_FAILED');
    }

    const branchResult = await this.git.run(worktreeRoot, [
      'symbolic-ref',
      '--quiet',
      '--short',
      'HEAD',
    ]);
    if (branchResult.exitCode === 1) return blocked('DETACHED_HEAD');
    const headBranch = readSingleLine(branchResult);
    if (headBranch !== worktree.branchName) return blocked('BRANCH_MISMATCH');

    const headCommitId = readObjectId(
      await this.git.run(worktreeRoot, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        'HEAD^{commit}',
      ]),
    );
    const status = await this.git.run(
      worktreeRoot,
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
      { maxBuffer: maximumGitOutput, timeout: 30_000 },
    );
    if (status.exitCode !== 0 || (status.stdout.length > 0 && !status.stdout.endsWith('\0'))) {
      return blocked('INSPECTION_FAILED');
    }
    if (status.stdout.length > 0) return blocked('UNCOMMITTED_CHANGES');

    const base = parseBaseRef(worktree.baseRefName);
    if (base === undefined) return blocked('INVALID_BASE_BRANCH');
    const verifiedBase = readObjectId(
      await this.git.run(worktreeRoot, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${worktree.baseCommitId}^{commit}`,
      ]),
    );
    if (verifiedBase !== worktree.baseCommitId) return blocked('INVALID_BASE_BRANCH');
    const ancestry = await this.git.run(worktreeRoot, [
      'merge-base',
      '--is-ancestor',
      worktree.baseCommitId,
      headCommitId,
    ]);
    if (ancestry.exitCode !== 0) return blocked('INVALID_BASE_BRANCH');
    const ahead = Number(
      readSingleLine(
        await this.git.run(worktreeRoot, [
          'rev-list',
          '--count',
          `${worktree.baseCommitId}..${headCommitId}`,
        ]),
      ),
    );
    if (!Number.isSafeInteger(ahead) || ahead < 0) return blocked('INSPECTION_FAILED');
    if (ahead === 0) return blocked('NO_COMMITS_AHEAD');

    if (await this.hasUnsafeLocalCommandConfiguration(worktreeRoot)) {
      return blocked('INSPECTION_FAILED');
    }
    const remote = await this.findGithubRemote(worktreeRoot, base.remoteName);
    if (remote === undefined) return blocked('GITHUB_REMOTE_NOT_FOUND');
    const remoteHeadCommitId = await this.readOptionalRemoteHead(
      worktreeRoot,
      remote.name,
      headBranch,
    );
    const githubCliAvailable = await this.github.isAvailable();
    return Object.freeze({
      baseBranch: base.branchName,
      githubAuthenticationAvailable: githubCliAvailable && (await this.github.isAuthenticated()),
      githubCliAvailable,
      headBranch,
      headCommitId,
      kind: 'ready',
      provider: 'github',
      pullRequest: undefined,
      remoteHeadCommitId,
      remoteName: remote.name,
      repositoryName: remote.repository.name,
      repositoryOwner: remote.repository.owner,
    });
  }

  private async readAbsoluteCommonDirectory(repositoryPath: string): Promise<string> {
    const result = await this.git.run(repositoryPath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    return normalize(await realpath(readSingleLine(result)));
  }

  private async hasUnsafeLocalCommandConfiguration(repositoryPath: string): Promise<boolean> {
    const result = await this.git.run(repositoryPath, [
      'config',
      '--local',
      '--includes',
      '--get-regexp',
      '^(url\\..*\\.(insteadof|pushinsteadof)|core\\.(sshcommand|askpass|gitproxy)|credential\\.helper|http\\.(proxy|sslverify|extraheader|curloptresolve)|http\\..*\\.(proxy|sslverify|extraheader|curloptresolve)|push\\.(gpgsign|pushoption)|remote\\..*\\.(receivepack|uploadpack|vcs|proxy|mirror))$',
    ]);
    if (result.exitCode === 1 && result.stdout.length === 0) return false;
    if (result.exitCode === 0) return true;
    throw new Error('Git configuration inspection failed.');
  }

  private async findGithubRemote(
    repositoryPath: string,
    preferredRemoteName: string | undefined,
  ): Promise<
    | {
        readonly name: string;
        readonly repository: GitHubRepository;
      }
    | undefined
  > {
    const result = await this.git.run(repositoryPath, ['remote']);
    const names = readLines(result, 'repository').filter(isSafeRemoteName);
    const ordered = [
      ...(preferredRemoteName === undefined ? [] : [preferredRemoteName]),
      ...(names.includes('origin') ? ['origin'] : []),
      ...names,
    ].filter((name, index, values) => values.indexOf(name) === index && names.includes(name));
    for (const name of ordered) {
      const [fetchResult, pushResult] = await Promise.all([
        this.git.run(repositoryPath, ['remote', 'get-url', '--all', name]),
        this.git.run(repositoryPath, ['remote', 'get-url', '--push', '--all', name]),
      ]);
      const urls = [
        ...readLines(fetchResult, 'repository'),
        ...readLines(pushResult, 'repository'),
      ];
      const repositories = urls.map(parseGithubRemoteUrl);
      const repository = repositories[0];
      if (
        repository !== undefined &&
        repositories.every(
          (candidate) =>
            candidate?.owner === repository.owner && candidate.name === repository.name,
        )
      ) {
        return Object.freeze({ name, repository });
      }
    }
    return undefined;
  }

  private async readOptionalRemoteHead(
    repositoryPath: string,
    remoteName: string,
    headBranch: string,
  ): Promise<string | undefined> {
    const result = await this.git.run(repositoryPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `refs/remotes/${remoteName}/${headBranch}^{commit}`,
    ]);
    if (result.exitCode === 1 && result.stdout.length === 0) return undefined;
    return readObjectId(result);
  }
}

function blocked(
  reason: Extract<PullRequestBranchInspection, { readonly kind: 'blocked' }>['reason'],
): PullRequestBranchInspection {
  return Object.freeze({ kind: 'blocked', reason });
}

function parseBaseRef(
  refName: string,
): { readonly branchName: string; readonly remoteName: string | undefined } | undefined {
  const remote = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(refName);
  if (remote?.[1] !== undefined && remote[2] !== undefined && remote[2] !== 'HEAD') {
    return Object.freeze({ branchName: remote[2], remoteName: remote[1] });
  }
  const local = /^refs\/heads\/(.+)$/u.exec(refName);
  return local?.[1] === undefined
    ? undefined
    : Object.freeze({ branchName: local[1], remoteName: undefined });
}

function parseGithubRemoteUrl(remoteUrl: string): GitHubRepository | undefined {
  const scp = /^git@github\.com:([A-Za-z0-9_.-]{1,255})\/([A-Za-z0-9_.-]{1,255}?)(?:\.git)?$/u.exec(
    remoteUrl,
  );
  if (scp?.[1] !== undefined && scp[2] !== undefined) {
    return Object.freeze({ name: removeGitSuffix(scp[2]), owner: scp[1] });
  }
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return undefined;
  }
  const https =
    url.protocol === 'https:' &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.port.length === 0;
  const ssh =
    url.protocol === 'ssh:' &&
    url.username === 'git' &&
    url.password.length === 0 &&
    (url.port.length === 0 || url.port === '22');
  if ((!https && !ssh) || url.hostname.toLowerCase() !== 'github.com') return undefined;
  const match = /^\/([A-Za-z0-9_.-]{1,255})\/([A-Za-z0-9_.-]{1,255})$/u.exec(url.pathname);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return Object.freeze({ name: removeGitSuffix(match[2]), owner: match[1] });
}

function removeGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name;
}

function readObjectId(result: { readonly exitCode: number; readonly stdout: string }): string {
  const value = readSingleLine(result);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error('Git object identity is invalid.');
  }
  return value;
}

function readSingleLine(result: { readonly exitCode: number; readonly stdout: string }): string {
  if (result.exitCode !== 0 || !result.stdout.endsWith('\n')) {
    throw new Error('Git output is invalid.');
  }
  const value = removeFinalLineEnding(result.stdout);
  if (value.length === 0 || value.includes('\n') || value.includes('\r') || value.includes('\0')) {
    throw new Error('Git output is invalid.');
  }
  return value;
}

function readLines(
  result: { readonly exitCode: number; readonly stdout: string },
  context: string,
): readonly string[] {
  if (result.exitCode !== 0) throw new Error('Git output is invalid.');
  if (result.stdout.length === 0) return Object.freeze([]);
  if (!result.stdout.endsWith('\n')) throw new Error(`Git output is invalid for ${context}.`);
  const values = removeFinalLineEnding(result.stdout).split(/\r?\n/u);
  if (values.some((value) => value.length === 0 || value.includes('\0'))) {
    throw new Error('Git output is invalid.');
  }
  return Object.freeze(values);
}

function isSafeRemoteName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(name);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function mapPullRequestList(
  value: unknown,
  taskId: string,
  branch: Extract<PullRequestBranchInspection, { readonly kind: 'ready' }>,
): readonly TaskPullRequest[] {
  if (!Array.isArray(value)) throw new Error('The GitHub Pull Request list is invalid.');
  return Object.freeze(
    value
      .filter((candidate) => isExactPullRequestCandidate(candidate, branch))
      .map((candidate) => mapPullRequest(candidate, taskId, branch)),
  );
}

function isExactPullRequestCandidate(
  value: unknown,
  branch: Extract<PullRequestBranchInspection, { readonly kind: 'ready' }>,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const base = record.base;
  const head = record.head;
  return (
    typeof base === 'object' &&
    base !== null &&
    !Array.isArray(base) &&
    typeof head === 'object' &&
    head !== null &&
    !Array.isArray(head) &&
    (base as Readonly<Record<string, unknown>>).ref === branch.baseBranch &&
    (head as Readonly<Record<string, unknown>>).ref === branch.headBranch &&
    (head as Readonly<Record<string, unknown>>).sha === branch.headCommitId
  );
}

function mapPullRequest(
  value: unknown,
  taskId: string,
  branch: Extract<PullRequestBranchInspection, { readonly kind: 'ready' }>,
): TaskPullRequest {
  const record = readRecord(value);
  const base = readRecord(record.base);
  const head = readRecord(record.head);
  const number = readPositiveSafeInteger(record.number);
  const baseBranch = readBoundedString(base.ref, 1024);
  const headBranch = readBoundedString(head.ref, 1024);
  const headCommitId = readObjectIdentity(head.sha);
  const expectedUrl = `https://github.com/${branch.repositoryOwner}/${branch.repositoryName}/pull/${String(number)}`;
  const remoteUrl = readGithubPullRequestUrl(record.html_url);
  if (
    baseBranch !== branch.baseBranch ||
    headBranch !== branch.headBranch ||
    headCommitId !== branch.headCommitId ||
    remoteUrl.owner.toLowerCase() !== branch.repositoryOwner.toLowerCase() ||
    remoteUrl.repository.toLowerCase() !== branch.repositoryName.toLowerCase() ||
    remoteUrl.number !== number
  ) {
    throw new Error('The GitHub Pull Request does not match the Task branch.');
  }
  const mergedAt = record.merged_at;
  const state = record.state;
  const status =
    typeof mergedAt === 'string'
      ? 'MERGED'
      : state === 'open'
        ? 'OPEN'
        : state === 'closed'
          ? 'CLOSED'
          : undefined;
  if (status === undefined || (mergedAt !== null && typeof mergedAt !== 'string')) {
    throw new Error('The GitHub Pull Request status is invalid.');
  }
  if (typeof mergedAt === 'string') readTimestamp(mergedAt);
  const createdAt = readTimestamp(record.created_at);
  const updatedAt = readTimestamp(record.updated_at);
  if (updatedAt < createdAt || typeof record.draft !== 'boolean') {
    throw new Error('The GitHub Pull Request metadata is invalid.');
  }
  return Object.freeze({
    baseBranch,
    createdAt,
    draft: record.draft,
    headBranch,
    headCommitId,
    number,
    provider: 'github',
    repositoryName: branch.repositoryName,
    repositoryOwner: branch.repositoryOwner,
    status,
    taskId,
    title: readBoundedString(record.title, 1024),
    updatedAt,
    url: expectedUrl,
  });
}

function selectSuitablePullRequest(
  candidates: readonly TaskPullRequest[],
): TaskPullRequest | undefined {
  return (
    candidates.find((candidate) => candidate.status === 'OPEN') ??
    candidates.find((candidate) => candidate.status === 'CLOSED') ??
    candidates.find((candidate) => candidate.status === 'MERGED')
  );
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The GitHub API response is invalid.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function readPositiveSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('The GitHub Pull Request number is invalid.');
  }
  return value;
}

function readBoundedString(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new Error('The GitHub API text is invalid.');
  }
  return value;
}

function readObjectIdentity(value: unknown): string {
  const identity = readBoundedString(value, 64);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity)) {
    throw new Error('The GitHub head identity is invalid.');
  }
  return identity;
}

function readTimestamp(value: unknown): number {
  const text = readBoundedString(value, 64);
  const timestamp = Date.parse(text);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('The GitHub timestamp is invalid.');
  }
  return timestamp;
}

function readGithubPullRequestUrl(value: unknown): {
  readonly number: number;
  readonly owner: string;
  readonly repository: string;
} {
  const text = readBoundedString(value, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('The GitHub Pull Request URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('The GitHub Pull Request URL is invalid.');
  }
  const match = /^\/([A-Za-z0-9_.-]{1,255})\/([A-Za-z0-9_.-]{1,255})\/pull\/([1-9][0-9]*)$/u.exec(
    url.pathname,
  );
  const number = Number(match?.[3]);
  if (match?.[1] === undefined || match[2] === undefined || !Number.isSafeInteger(number)) {
    throw new Error('The GitHub Pull Request URL is invalid.');
  }
  return Object.freeze({ number, owner: match[1], repository: match[2] });
}

function readGithubReferenceHead(value: unknown): string {
  return readObjectIdentity(readRecord(readRecord(value).object).sha);
}

function encodeGithubRefPath(value: string): string {
  if (value.length === 0 || value.includes('\0')) throw new Error('The GitHub ref is invalid.');
  return value.split('/').map(encodeURIComponent).join('/');
}
