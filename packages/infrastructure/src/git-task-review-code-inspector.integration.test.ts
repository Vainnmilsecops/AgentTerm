import { execFileSync } from 'node:child_process';
import {
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { TaskWorktree } from '@agentterm/application';

import { GitCliTaskReviewCodeInspector } from './index';

interface ReviewWorktreeFixture {
  readonly baseCommitId: string;
  readonly repositoryPath: string;
  readonly worktree: TaskWorktree;
}

async function withReviewWorktree(
  run: (fixture: ReviewWorktreeFixture) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-review-code-'));
  const repositoryPath = join(directory, 'Repository With Spaces');
  const worktreePath = join(directory, 'Review Worktree');
  const branchName = 'agentterm/task/review-code-fixture';

  try {
    initializeRepository(repositoryPath);
    mkdirSync(join(repositoryPath, 'directory'));
    writeFileSync(join(repositoryPath, '.gitignore'), '*.ignored\n');
    writeFileSync(join(repositoryPath, 'directory', 'tracked-nested.txt'), 'nested base\n');
    writeFileSync(join(repositoryPath, 'tracked.txt'), 'base tracked content\n');
    writeFileSync(join(repositoryPath, '.gitattributes'), '*.txt diff=hostile\n');
    const baseCommitId = commitAll(repositoryPath, 'Base commit');
    runGit(repositoryPath, [
      'worktree',
      'add',
      '--quiet',
      '-b',
      branchName,
      worktreePath,
      baseCommitId,
    ]);
    const canonicalRepositoryPath = realpathSync.native(repositoryPath);
    const canonicalWorktreePath = realpathSync.native(worktreePath);
    const worktree: TaskWorktree = Object.freeze({
      baseCommitId,
      baseRefName: 'refs/heads/main',
      branchName,
      pathIdentity: createPathIdentity(canonicalWorktreePath),
      repositoryRootPath: canonicalRepositoryPath,
      taskId: 'task-review-code',
      worktreePath: canonicalWorktreePath,
    });

    await run({ baseCommitId, repositoryPath: canonicalRepositoryPath, worktree });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

describe('GitCliTaskReviewCodeInspector', () => {
  it('captures committed, staged, unstaged, and untracked content with an exact stable fingerprint', async () => {
    await withReviewWorktree(async ({ baseCommitId, repositoryPath, worktree }) => {
      writeFileSync(join(worktree.worktreePath, 'committed.txt'), 'committed content\n');
      const headCommitId = commitAll(worktree.worktreePath, 'Task commit');
      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'staged content\n');
      runGit(worktree.worktreePath, ['add', '--', 'tracked.txt']);
      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'unstaged version one\n');
      writeFileSync(join(worktree.worktreePath, 'Unicode Ω.txt'), 'untracked version one\n');
      const statusBefore = runGit(worktree.worktreePath, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
      ]);
      const objectEntriesBefore = listObjectEntries(repositoryPath);
      const inspector = new GitCliTaskReviewCodeInspector();

      const first = await inspector.inspect(worktree);
      const repeated = await inspector.inspect(worktree);

      expect(first).toEqual({
        baseCommitId,
        branchName: worktree.branchName,
        changes: {
          committed: ['committed.txt'],
          conflicted: [],
          staged: ['tracked.txt'],
          total: 3,
          truncated: false,
          unstaged: ['tracked.txt'],
          untracked: ['Unicode Ω.txt'],
        },
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
        headCommitId,
        schemaVersion: 1,
        worktreePathIdentity: worktree.pathIdentity,
      });
      expect(repeated).toEqual(first);
      expect(first).not.toHaveProperty('worktreePath');
      expect(first).not.toHaveProperty('repositoryRootPath');
      expect(
        runGit(worktree.worktreePath, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      ).toBe(statusBefore);
      expect(listObjectEntries(repositoryPath)).toEqual(objectEntriesBefore);

      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'unstaged version two\n');
      const changedTrackedBytes = await inspector.inspect(worktree);
      expect(changedTrackedBytes.changes).toEqual(first.changes);
      expect(changedTrackedBytes.fingerprint).not.toBe(first.fingerprint);

      writeFileSync(join(worktree.worktreePath, 'Unicode Ω.txt'), 'untracked version two\n');
      const changedUntrackedBytes = await inspector.inspect(worktree);
      expect(changedUntrackedBytes.changes).toEqual(first.changes);
      expect(changedUntrackedBytes.fingerprint).not.toBe(changedTrackedBytes.fingerprint);

      runGit(worktree.worktreePath, ['add', '--', 'tracked.txt']);
      const changedIndex = await inspector.inspect(worktree);
      expect(changedIndex.changes).toEqual({
        ...first.changes,
        unstaged: [],
      });
      expect(changedIndex.fingerprint).not.toBe(changedUntrackedBytes.fingerprint);
    });
  }, 15_000);

  it('detects same-size tracked content changes hidden by the Git stat cache', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const trackedPath = join(worktree.worktreePath, 'tracked.txt');
      runGit(worktree.worktreePath, ['config', '--local', 'core.trustctime', 'false']);
      runGit(worktree.worktreePath, ['config', '--local', 'core.checkStat', 'minimal']);
      const cachedTimestamp = new Date('2020-01-02T03:04:05.000Z');
      utimesSync(trackedPath, cachedTimestamp, cachedTimestamp);
      runGit(worktree.worktreePath, ['update-index', '--really-refresh']);
      const originalBytes = readFileSync(trackedPath);
      const originalMetadata = statSync(trackedPath);
      const inspector = new GitCliTaskReviewCodeInspector();
      const first = await inspector.inspect(worktree);

      const replacementBytes = Buffer.from(originalBytes);
      replacementBytes[0] = replacementBytes[0] === 0x61 ? 0x62 : 0x61;
      writeFileSync(trackedPath, replacementBytes);
      utimesSync(trackedPath, originalMetadata.atime, originalMetadata.mtime);

      expect(readFileSync(trackedPath)).not.toEqual(originalBytes);
      expect(
        runGit(worktree.worktreePath, [
          '-c',
          'core.fsmonitor=false',
          'status',
          '--porcelain=v2',
          '-z',
          '--untracked-files=all',
        ]),
      ).toBe('');

      const changed = await inspector.inspect(worktree);

      expect(changed.changes).toEqual(first.changes);
      expect(changed.fingerprint).not.toBe(first.fingerprint);
    });
  });

  it('bounds displayed paths across categories without weakening the complete fingerprint', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      for (let index = 204; index >= 0; index -= 1) {
        writeFileSync(
          join(worktree.worktreePath, `untracked-${index.toString().padStart(3, '0')}.txt`),
          `content ${index}\n`,
        );
      }
      const inspector = new GitCliTaskReviewCodeInspector();

      const state = await inspector.inspect(worktree);

      expect(state.changes).toMatchObject({
        committed: [],
        conflicted: [],
        staged: [],
        total: 205,
        truncated: true,
        unstaged: [],
      });
      expect(state.changes.untracked).toHaveLength(200);
      expect(state.changes.untracked[0]).toBe('untracked-000.txt');
      expect(state.changes.untracked.at(-1)).toBe('untracked-199.txt');
      expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    });
  }, 15_000);

  it('rejects a clean tracked snapshot larger than the fingerprint byte budget', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const largeCommittedPath = join(worktree.worktreePath, 'large-committed.bin');
      writeFileSync(largeCommittedPath, '');
      truncateSync(largeCommittedPath, 65 * 1024 * 1024);
      commitAll(worktree.worktreePath, 'Large committed fixture');
      const inspector = new GitCliTaskReviewCodeInspector();

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        name: 'TaskWorktreeLifecycleError',
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });
    });
  }, 15_000);

  it('never reads beyond the fingerprint byte budget when a tracked file grows', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const maximumFingerprintBytes = 64 * 1024 * 1024;
      const existingTrackedBytes = [
        '.gitattributes',
        '.gitignore',
        'directory/tracked-nested.txt',
        'tracked.txt',
      ].reduce((total, path) => total + statSync(join(worktree.worktreePath, path)).size, 0);
      const growingPath = join(worktree.worktreePath, 'zz-growing.bin');
      writeFileSync(growingPath, '');
      truncateSync(growingPath, maximumFingerprintBytes - existingTrackedBytes);
      commitAll(worktree.worktreePath, 'Exact fingerprint budget fixture');
      const growingIdentity = statSync(growingPath, { bigint: true });

      const probeHandle = await open(growingPath, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as {
        read: FileHandle['read'];
      };
      const originalRead = fileHandlePrototype.read;
      await probeHandle.close();
      let actualBytesRead = 0;
      let growingDescriptor: number | undefined;
      let grewDuringRead = false;
      const instrumentedRead = async function <T extends NodeJS.ArrayBufferView>(
        this: FileHandle,
        buffer: T,
        offset?: number | null,
        length?: number | null,
        position?: number | null,
      ) {
        const result = (await Reflect.apply(originalRead, this, [
          buffer,
          offset,
          length,
          position,
        ])) as { readonly buffer: T; readonly bytesRead: number };
        actualBytesRead += result.bytesRead;
        if (growingDescriptor === undefined) {
          const currentIdentity = fstatSync(this.fd, { bigint: true });
          if (
            currentIdentity.dev === growingIdentity.dev &&
            currentIdentity.ino === growingIdentity.ino &&
            currentIdentity.size === growingIdentity.size
          ) {
            growingDescriptor = this.fd;
          }
        }
        if (!grewDuringRead && this.fd === growingDescriptor && result.bytesRead > 0) {
          truncateSync(growingPath, statSync(growingPath).size + 1);
          grewDuringRead = true;
        }
        return result;
      };
      const readSpy = vi
        .spyOn(fileHandlePrototype, 'read')
        .mockImplementation(instrumentedRead as FileHandle['read']);
      const inspector = new GitCliTaskReviewCodeInspector();

      try {
        await expect(inspector.inspect(worktree)).rejects.toMatchObject({
          name: 'TaskWorktreeLifecycleError',
          reason: 'GIT_OPERATION_FAILED',
          taskId: worktree.taskId,
        });
      } finally {
        readSpy.mockRestore();
      }

      expect(grewDuringRead).toBe(true);
      expect(actualBytesRead).toBeLessThanOrEqual(maximumFingerprintBytes);
    });
  }, 30_000);

  it('rejects an oversized untracked snapshot', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const oversizedDirtyPath = join(worktree.worktreePath, 'oversized-untracked.bin');
      writeFileSync(oversizedDirtyPath, '');
      truncateSync(oversizedDirtyPath, 65 * 1024 * 1024);
      const inspector = new GitCliTaskReviewCodeInspector();

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        name: 'TaskWorktreeLifecycleError',
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });
    });
  }, 15_000);

  it('rejects recorded path, branch, base, and repository identity mismatches', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const inspector = new GitCliTaskReviewCodeInspector();
      const wrongObjectId = 'f'.repeat(40);
      const cases: readonly TaskWorktree[] = [
        { ...worktree, pathIdentity: `${worktree.pathIdentity}-mismatch` },
        { ...worktree, branchName: 'agentterm/task/not-the-checked-out-branch' },
        { ...worktree, baseCommitId: wrongObjectId },
        { ...worktree, repositoryRootPath: worktree.worktreePath },
      ];

      for (const mismatched of cases) {
        await expect(inspector.inspect(mismatched)).rejects.toMatchObject({
          name: 'TaskWorktreeLifecycleError',
          reason: 'WORKTREE_MISMATCH',
          taskId: worktree.taskId,
        });
      }
    });
  });

  it('does not invoke repository-configured external diff or textconv commands', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const markerPath = join(worktree.worktreePath, 'external-diff-ran.txt');
      runGit(worktree.worktreePath, [
        'config',
        '--local',
        'diff.external',
        `agentterm-must-not-run > "${markerPath}"`,
      ]);
      runGit(worktree.worktreePath, [
        'config',
        '--local',
        'diff.hostile.textconv',
        `agentterm-must-not-run > "${markerPath}"`,
      ]);
      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'changed content\n');
      const inspector = new GitCliTaskReviewCodeInspector();

      const state = await inspector.inspect(worktree);

      expect(state.changes.unstaged).toEqual(['tracked.txt']);
      expect(existsSync(markerPath)).toBe(false);
    });
  });

  it('fails closed when index flags can hide tracked working-tree changes', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const inspector = new GitCliTaskReviewCodeInspector();
      runGit(worktree.worktreePath, ['update-index', '--assume-unchanged', '--', 'tracked.txt']);
      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'hidden assume-unchanged bytes\n');

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });

      runGit(worktree.worktreePath, ['update-index', '--no-assume-unchanged', '--', 'tracked.txt']);
      runGit(worktree.worktreePath, ['checkout', '--', 'tracked.txt']);
      runGit(worktree.worktreePath, ['update-index', '--skip-worktree', '--', 'tracked.txt']);
      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'hidden skip-worktree bytes\n');

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });
    });
  });

  it('reports unresolved conflicts separately from staged and unstaged changes', async () => {
    await withReviewWorktree(async ({ repositoryPath, worktree }) => {
      writeFileSync(join(worktree.worktreePath, 'tracked.txt'), 'Task branch content\n');
      commitAll(worktree.worktreePath, 'Task branch change');
      writeFileSync(join(repositoryPath, 'tracked.txt'), 'Base branch content\n');
      commitAll(repositoryPath, 'Base branch change');
      expect(() => runGit(worktree.worktreePath, ['merge', '--no-edit', 'main'])).toThrow();
      const inspector = new GitCliTaskReviewCodeInspector();

      const state = await inspector.inspect(worktree);

      expect(state.changes).toEqual({
        committed: ['tracked.txt'],
        conflicted: ['tracked.txt'],
        staged: [],
        total: 1,
        truncated: false,
        unstaged: [],
        untracked: [],
      });
    });
  });

  it('fails closed when a changed submodule contains dirty working content', async () => {
    await withReviewWorktree(async ({ repositoryPath, worktree }) => {
      const submoduleSourcePath = join(dirname(repositoryPath), 'Submodule Source');
      initializeRepository(submoduleSourcePath);
      writeFileSync(join(submoduleSourcePath, 'library.txt'), 'library base\n');
      commitAll(submoduleSourcePath, 'Library base');
      runGit(worktree.worktreePath, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--quiet',
        submoduleSourcePath,
        'vendor/library',
      ]);
      commitAll(worktree.worktreePath, 'Add submodule');
      writeFileSync(
        join(worktree.worktreePath, 'vendor', 'library', 'library.txt'),
        'dirty library content\n',
      );
      const inspector = new GitCliTaskReviewCodeInspector();

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        name: 'TaskWorktreeLifecycleError',
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });
    });
  });

  it('keeps ignored content explicitly outside the versioned code-state fingerprint', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const ignoredPath = join(worktree.worktreePath, 'generated.ignored');
      writeFileSync(ignoredPath, 'ignored version one\n');
      const inspector = new GitCliTaskReviewCodeInspector();
      const first = await inspector.inspect(worktree);

      writeFileSync(ignoredPath, 'ignored version two\n');
      const second = await inspector.inspect(worktree);

      expect(first.changes).toEqual(second.changes);
      expect(second.fingerprint).toBe(first.fingerprint);
    });
  });

  it.runIf(process.platform !== 'win32')(
    'hashes an untracked symlink target without following it outside the Worktree',
    async () => {
      await withReviewWorktree(async ({ repositoryPath, worktree }) => {
        const outsidePath = join(dirname(repositoryPath), 'outside-secret.txt');
        const linkPath = join(worktree.worktreePath, 'outside-link.txt');
        writeFileSync(outsidePath, 'outside version one\n');
        symlinkSync(outsidePath, linkPath, 'file');
        const inspector = new GitCliTaskReviewCodeInspector();
        const first = await inspector.inspect(worktree);

        writeFileSync(outsidePath, 'outside version two\n');
        const second = await inspector.inspect(worktree);

        expect(second.changes.untracked).toEqual(['outside-link.txt']);
        expect(second.fingerprint).toBe(first.fingerprint);
      });
    },
  );

  it('fails closed instead of hashing through a symlinked directory ancestor', async () => {
    await withReviewWorktree(async ({ repositoryPath, worktree }) => {
      const trackedDirectory = join(worktree.worktreePath, 'directory');
      const outsideDirectory = join(dirname(repositoryPath), 'Outside Directory');
      mkdirSync(outsideDirectory);
      writeFileSync(join(outsideDirectory, 'tracked-nested.txt'), 'outside secret bytes\n');
      rmSync(trackedDirectory, { force: true, recursive: true });
      symlinkSync(
        outsideDirectory,
        trackedDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const inspector = new GitCliTaskReviewCodeInspector();

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        name: 'TaskWorktreeLifecycleError',
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });
    });
  });

  it('fails closed when a nested repository is an unsupported changed directory', async () => {
    await withReviewWorktree(async ({ worktree }) => {
      const nestedRepositoryPath = join(worktree.worktreePath, 'nested-repository');
      initializeRepository(nestedRepositoryPath);
      writeFileSync(join(nestedRepositoryPath, 'nested.txt'), 'nested code\n');
      commitAll(nestedRepositoryPath, 'Nested commit');
      const inspector = new GitCliTaskReviewCodeInspector();

      await expect(inspector.inspect(worktree)).rejects.toMatchObject({
        name: 'TaskWorktreeLifecycleError',
        reason: 'GIT_OPERATION_FAILED',
        taskId: worktree.taskId,
      });
    });
  });
});

function initializeRepository(repositoryPath: string): void {
  execFileSync('git', ['init', '--initial-branch=main', '--quiet', repositoryPath], {
    cwd: dirname(process.execPath),
    env: createTestGitEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function commitAll(repositoryPath: string, message: string): string {
  runGit(repositoryPath, ['add', '--all']);
  runGit(repositoryPath, [
    '-c',
    'user.name=AgentTerm Tests',
    '-c',
    'user.email=agentterm-tests@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--quiet',
    '--no-gpg-sign',
    '-m',
    message,
  ]);
  return removeFinalLineEnding(runGit(repositoryPath, ['rev-parse', 'HEAD']));
}

function runGit(repositoryPath: string, arguments_: readonly string[]): string {
  return execFileSync(
    'git',
    ['--no-optional-locks', '-C', repositoryPath, '-c', 'core.autocrlf=false', ...arguments_],
    {
      cwd: dirname(process.execPath),
      encoding: 'utf8',
      env: createTestGitEnvironment(),
      windowsHide: true,
    },
  );
}

function createTestGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowedNames = new Set([
    'APPDATA',
    'HOME',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ]);

  for (const [name, value] of Object.entries(process.env)) {
    if (allowedNames.has(name.toUpperCase()) && value !== undefined) {
      environment[name] = value;
    }
  }

  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function createPathIdentity(path: string): string {
  const normalizedPath = normalize(path);
  return process.platform === 'win32'
    ? `win32:${normalizedPath.toLocaleLowerCase('en-US')}`
    : `posix:${normalizedPath}`;
}

function listObjectEntries(repositoryPath: string): readonly string[] {
  return readdirSync(join(repositoryPath, '.git', 'objects'), { recursive: true })
    .map(String)
    .sort();
}

function removeFinalLineEnding(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2);
  }
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}
