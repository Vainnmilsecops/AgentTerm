import { execFileSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitRepositoryInspectionError } from '@agentterm/application';

import { GitCliRepositoryInspector } from './index';

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-git-inspector-'));

  try {
    await run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
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

function runGitWithInput(
  repositoryPath: string,
  arguments_: readonly string[],
  input: string,
): string {
  return execFileSync(
    'git',
    ['--no-optional-locks', '-C', repositoryPath, '-c', 'core.autocrlf=false', ...arguments_],
    {
      cwd: dirname(process.execPath),
      encoding: 'utf8',
      env: createTestGitEnvironment(),
      input,
      windowsHide: true,
    },
  );
}

function initializeRepository(repositoryPath: string, initialBranch = 'main'): void {
  execFileSync('git', ['init', `--initial-branch=${initialBranch}`, '--quiet', repositoryPath], {
    cwd: dirname(process.execPath),
    env: createTestGitEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function initializeBareRepository(repositoryPath: string): void {
  execFileSync('git', ['init', '--bare', '--quiet', repositoryPath], {
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

  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function removeFinalLineEnding(value: string): string {
  return value.endsWith('\r\n') ? value.slice(0, -2) : value.slice(0, -1);
}

function listObjectDatabaseEntries(repositoryPath: string): readonly string[] {
  return readdirSync(join(repositoryPath, '.git', 'objects'), { recursive: true })
    .map((entry) => entry.toString())
    .sort();
}

async function expectInspectionFailure(
  result: Promise<unknown>,
  reason: GitRepositoryInspectionError['reason'],
): Promise<void> {
  await expect(result).rejects.toMatchObject({
    name: 'GitRepositoryInspectionError',
    reason,
  });
}

describe('GitCliRepositoryInspector', () => {
  it('returns one clean snapshot from a nested repository path', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'Repository With Spaces');
      const nestedPath = join(repositoryPath, 'packages', 'domain');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      const commitId = commitAll(repositoryPath, 'Initial commit');
      mkdirSync(nestedPath, { recursive: true });
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(nestedPath);

      expect(result).toEqual({
        kind: 'repository',
        repository: {
          head: { branchName: 'main', commitId, kind: 'attached' },
          rootPath: realpathSync.native(repositoryPath),
          status: {
            conflictedPaths: [],
            isDirty: false,
            stagedPaths: [],
            unstagedPaths: [],
            untrackedPaths: [],
          },
          suggestedBaseBranch: {
            name: 'main',
            refName: 'refs/heads/main',
            source: 'local-main',
          },
        },
      });
    });
  });

  it('reports staged, unstaged, and untracked paths despite repository status config', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      const trackedPath = join(repositoryPath, 'tracked.txt');
      const renameSourcePath = join(repositoryPath, 'rename-source.txt');
      const untrackedName = '-- odd # Unicode Ω.txt';
      initializeRepository(repositoryPath);
      writeFileSync(trackedPath, 'initial\n');
      writeFileSync(renameSourcePath, 'rename me\n');
      commitAll(repositoryPath, 'Initial commit');

      writeFileSync(trackedPath, 'staged\n');
      runGit(repositoryPath, ['add', '--', 'tracked.txt']);
      writeFileSync(trackedPath, 'unstaged after staged\n');
      runGit(repositoryPath, ['mv', '--', 'rename-source.txt', 'rename-target.txt']);
      writeFileSync(join(repositoryPath, untrackedName), 'untracked\n');
      runGit(repositoryPath, ['config', '--local', 'status.showUntrackedFiles', 'no']);
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result.kind).toBe('repository');

      if (result.kind !== 'repository') {
        throw new Error('Expected a Git repository snapshot.');
      }

      expect(result.repository.status).toEqual({
        conflictedPaths: [],
        isDirty: true,
        stagedPaths: expect.arrayContaining([
          'rename-source.txt',
          'rename-target.txt',
          'tracked.txt',
        ]),
        unstagedPaths: ['tracked.txt'],
        untrackedPaths: [untrackedName],
      });
      expect(result.repository.status.stagedPaths).toHaveLength(3);
    });
  });

  it('reports an unresolved merge as a conflicted dirty working tree', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      const conflictPath = join(repositoryPath, 'conflict.txt');
      initializeRepository(repositoryPath);
      writeFileSync(conflictPath, 'base\n');
      commitAll(repositoryPath, 'Base commit');

      runGit(repositoryPath, ['switch', '--quiet', '-c', 'feature']);
      writeFileSync(conflictPath, 'feature\n');
      commitAll(repositoryPath, 'Feature change');
      runGit(repositoryPath, ['switch', '--quiet', 'main']);
      writeFileSync(conflictPath, 'main\n');
      commitAll(repositoryPath, 'Main change');
      expect(() => runGit(repositoryPath, ['merge', '--no-edit', 'feature'])).toThrow();
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result.kind).toBe('repository');

      if (result.kind !== 'repository') {
        throw new Error('Expected a Git repository snapshot.');
      }

      expect(result.repository.status).toEqual({
        conflictedPaths: ['conflict.txt'],
        isDirty: true,
        stagedPaths: [],
        unstagedPaths: [],
        untrackedPaths: [],
      });
    });
  });

  it('represents an unborn branch without inventing a commit or base revision', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath);
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toEqual({
        kind: 'repository',
        repository: {
          head: { branchName: 'main', kind: 'unborn' },
          rootPath: realpathSync.native(repositoryPath),
          status: {
            conflictedPaths: [],
            isDirty: false,
            stagedPaths: [],
            unstagedPaths: [],
            untrackedPaths: [],
          },
          suggestedBaseBranch: undefined,
        },
      });
    });
  });

  it('represents detached HEAD while retaining a committed local base suggestion', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      const commitId = commitAll(repositoryPath, 'Initial commit');
      runGit(repositoryPath, ['switch', '--quiet', '--detach', 'HEAD']);
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toMatchObject({
        kind: 'repository',
        repository: {
          head: { commitId, kind: 'detached' },
          suggestedBaseBranch: {
            name: 'main',
            refName: 'refs/heads/main',
            source: 'local-main',
          },
        },
      });
    });
  });

  it('does not confuse an attached branch named (detached) with detached HEAD', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      const commitId = commitAll(repositoryPath, 'Initial commit');
      runGit(repositoryPath, ['switch', '--quiet', '-c', '(detached)']);
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toMatchObject({
        kind: 'repository',
        repository: {
          head: { branchName: '(detached)', commitId, kind: 'attached' },
        },
      });
    });
  });

  it('prefers the verified local origin HEAD target as the base suggestion', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      commitAll(repositoryPath, 'Initial commit');
      runGit(repositoryPath, ['update-ref', 'refs/remotes/origin/trunk', 'HEAD']);
      runGit(repositoryPath, [
        'symbolic-ref',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/trunk',
      ]);
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toMatchObject({
        kind: 'repository',
        repository: {
          suggestedBaseBranch: {
            name: 'origin/trunk',
            refName: 'refs/remotes/origin/trunk',
            source: 'remote-head',
          },
        },
      });
    });
  });

  it('uses the committed current branch only after remote and conventional fallbacks', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath, 'topic');
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      commitAll(repositoryPath, 'Initial commit');
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toMatchObject({
        kind: 'repository',
        repository: {
          suggestedBaseBranch: {
            name: 'topic',
            refName: 'refs/heads/topic',
            source: 'current-branch',
          },
        },
      });
    });
  });

  it('uses committed master as the legacy conventional base', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath, 'master');
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      commitAll(repositoryPath, 'Initial commit');
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toMatchObject({
        kind: 'repository',
        repository: {
          suggestedBaseBranch: {
            name: 'master',
            refName: 'refs/heads/master',
            source: 'local-master',
          },
        },
      });
    });
  });

  it('selects a base without enumerating unrelated repository refs', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      initializeRepository(repositoryPath, 'topic');
      writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
      const commitId = commitAll(repositoryPath, 'Initial commit');
      const refUpdates = Array.from(
        { length: 1_100 },
        (_, index) =>
          `create refs/heads/main/archive-${index.toString().padStart(4, '0')}-${'x'.repeat(40)} ${commitId}\n`,
      ).join('');
      runGitWithInput(repositoryPath, ['update-ref', '--stdin'], refUpdates);
      const inspector = new GitCliRepositoryInspector();

      const result = await inspector.inspect(repositoryPath);

      expect(result).toMatchObject({
        kind: 'repository',
        repository: {
          suggestedBaseBranch: {
            name: 'topic',
            refName: 'refs/heads/topic',
            source: 'current-branch',
          },
        },
      });
    });
  });

  it('detects ordinary and bare directories as unsupported working trees', async () => {
    await withTemporaryDirectory(async (directory) => {
      const plainDirectory = join(directory, 'plain');
      const bareRepository = join(directory, 'bare.git');
      mkdirSync(plainDirectory);
      initializeBareRepository(bareRepository);
      const inspector = new GitCliRepositoryInspector();

      await expect(inspector.inspect(plainDirectory)).resolves.toEqual({
        kind: 'not-working-tree',
      });
      await expect(inspector.inspect(bareRepository)).resolves.toEqual({
        kind: 'not-working-tree',
      });
    });
  });

  it('maps invalid, missing, file, and unavailable-Git failures without raw command output', async () => {
    await withTemporaryDirectory(async (directory) => {
      const filePath = join(directory, 'file.txt');
      writeFileSync(filePath, 'not a directory');
      const inspector = new GitCliRepositoryInspector();
      const unavailableInspector = new GitCliRepositoryInspector('missing-agentterm-git.exe');

      await expectInspectionFailure(inspector.inspect('relative\\repository'), 'INVALID_PATH');
      await expectInspectionFailure(
        inspector.inspect(join(directory, 'missing')),
        'PATH_NOT_FOUND',
      );
      await expectInspectionFailure(inspector.inspect(filePath), 'PATH_NOT_DIRECTORY');
      await expectInspectionFailure(unavailableInspector.inspect(directory), 'GIT_NOT_AVAILABLE');
    });
  });

  it('does not let inherited Git environment redirect repository detection', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'actual-repository');
      const plainDirectory = join(directory, 'plain-directory');
      initializeRepository(repositoryPath);
      mkdirSync(plainDirectory);
      const originalGitDirectory = process.env.GIT_DIR;
      const originalGitWorkTree = process.env.GIT_WORK_TREE;
      const originalGitIndex = process.env.GIT_INDEX_FILE;

      process.env.GIT_DIR = join(repositoryPath, '.git');
      process.env.GIT_WORK_TREE = repositoryPath;
      process.env.GIT_INDEX_FILE = join(repositoryPath, '.git', 'index');

      try {
        const inspector = new GitCliRepositoryInspector();

        await expect(inspector.inspect(plainDirectory)).resolves.toEqual({
          kind: 'not-working-tree',
        });
      } finally {
        restoreEnvironmentVariable('GIT_DIR', originalGitDirectory);
        restoreEnvironmentVariable('GIT_WORK_TREE', originalGitWorkTree);
        restoreEnvironmentVariable('GIT_INDEX_FILE', originalGitIndex);
      }
    });
  });

  it('does not lazily fetch a promised object while inspecting a partial repository', async () => {
    await withTemporaryDirectory(async (directory) => {
      const sourcePath = join(directory, 'source');
      const partialPath = join(directory, 'partial');
      initializeRepository(sourcePath);
      writeFileSync(join(sourcePath, 'README.md'), '# Fixture\n');
      const promisedCommit = commitAll(sourcePath, 'Promised commit');

      initializeRepository(partialPath);
      runGit(partialPath, ['remote', 'add', 'origin', sourcePath]);
      runGit(partialPath, ['config', '--local', 'core.repositoryformatversion', '1']);
      runGit(partialPath, ['config', '--local', 'extensions.partialClone', 'origin']);
      runGit(partialPath, ['config', '--local', 'remote.origin.promisor', 'true']);
      runGit(partialPath, ['config', '--local', 'remote.origin.partialCloneFilter', 'blob:none']);
      writeFileSync(join(partialPath, '.git', 'refs', 'heads', 'main'), `${promisedCommit}\n`);
      const objectEntriesBefore = listObjectDatabaseEntries(partialPath);
      const inspector = new GitCliRepositoryInspector();

      await expectInspectionFailure(inspector.inspect(partialPath), 'GIT_INSPECTION_FAILED');
      expect(listObjectDatabaseEntries(partialPath)).toEqual(objectEntriesBefore);
    });
  });

  it.runIf(process.platform === 'win32')(
    'disables a repository-configured filesystem monitor during status inspection',
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const repositoryPath = join(directory, 'repository');
        const monitorPath = join(repositoryPath, '.git', 'agentterm-fsmonitor');
        const markerPath = join(repositoryPath, 'fsmonitor-invoked.txt');
        initializeRepository(repositoryPath);
        writeFileSync(join(repositoryPath, 'README.md'), '# Fixture\n');
        commitAll(repositoryPath, 'Initial commit');
        writeFileSync(monitorPath, '#!/bin/sh\nprintf invoked > fsmonitor-invoked.txt\nexit 1\n');
        chmodSync(monitorPath, 0o755);
        runGit(repositoryPath, [
          'config',
          '--local',
          'core.fsmonitor',
          monitorPath.replaceAll('\\', '/'),
        ]);

        runGit(repositoryPath, ['status', '--porcelain=v2', '-z']);
        expect(existsSync(markerPath)).toBe(true);
        unlinkSync(markerPath);

        const inspector = new GitCliRepositoryInspector();
        await expect(inspector.inspect(repositoryPath)).resolves.toMatchObject({
          kind: 'repository',
        });
        expect(existsSync(markerPath)).toBe(false);
      });
    },
  );
});

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
