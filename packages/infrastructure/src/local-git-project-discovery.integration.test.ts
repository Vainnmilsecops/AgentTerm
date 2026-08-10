import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { ProjectOpenError } from '@agentterm/application';

import { LocalGitProjectDiscovery } from './index';

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'agentterm-project-discovery-'));

  try {
    await run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function initializeGitRepository(path: string, bare = false): void {
  const arguments_ = bare ? ['init', '--bare', '--quiet', path] : ['init', '--quiet', path];
  execFileSync('git', arguments_, {
    cwd: dirname(process.execPath),
    stdio: 'ignore',
    windowsHide: true,
  });
}

async function expectProjectOpenFailure(
  result: Promise<unknown>,
  reason: ProjectOpenError['reason'],
): Promise<void> {
  await expect(result).rejects.toMatchObject({ name: 'ProjectOpenError', reason });
}

describe('LocalGitProjectDiscovery', () => {
  it('resolves a nested path, alternate casing, and trailing separator to one canonical root', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'Repository With Spaces & Symbols');
      const nestedPath = join(repositoryPath, 'packages', 'application');
      initializeGitRepository(repositoryPath);
      mkdirSync(nestedPath, { recursive: true });
      const discovery = new LocalGitProjectDiscovery();

      const root = await discovery.discover(repositoryPath);
      const nested = await discovery.discover(nestedPath);
      const alternateCase = await discovery.discover(`${repositoryPath.toLowerCase()}\\`);

      expect(root).toMatchObject({ name: 'Repository With Spaces & Symbols' });
      expect(root.id).toMatch(/^project-[a-f0-9]{64}$/u);
      expect(nested).toEqual(root);
      expect(alternateCase).toEqual(root);
    });
  });

  it('resolves a directory junction to the same repository identity', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'repository');
      const junctionPath = join(directory, 'repository-junction');
      initializeGitRepository(repositoryPath);
      symlinkSync(repositoryPath, junctionPath, 'junction');

      try {
        const discovery = new LocalGitProjectDiscovery();

        const repository = await discovery.discover(repositoryPath);
        const junction = await discovery.discover(junctionPath);

        expect(junction).toEqual(repository);
      } finally {
        unlinkSync(junctionPath);
      }
    });
  });

  it.each([
    ['', 'INVALID_PATH'],
    ['relative\\repository', 'INVALID_PATH'],
    ['invalid\0path', 'INVALID_PATH'],
  ] as const)('rejects invalid input path %j', async (path, reason) => {
    const discovery = new LocalGitProjectDiscovery();

    await expectProjectOpenFailure(discovery.discover(path), reason);
  });

  it('distinguishes missing paths, files, non-Git folders, and bare repositories', async () => {
    await withTemporaryDirectory(async (directory) => {
      const filePath = join(directory, 'file.txt');
      const plainDirectory = join(directory, 'plain-directory');
      const bareRepository = join(directory, 'bare.git');
      writeFileSync(filePath, 'not a directory');
      mkdirSync(plainDirectory);
      initializeGitRepository(bareRepository, true);
      const discovery = new LocalGitProjectDiscovery();

      await expectProjectOpenFailure(
        discovery.discover(join(directory, 'missing')),
        'PATH_NOT_FOUND',
      );
      await expectProjectOpenFailure(discovery.discover(filePath), 'PATH_NOT_DIRECTORY');
      await expectProjectOpenFailure(discovery.discover(plainDirectory), 'NOT_GIT_REPOSITORY');
      await expectProjectOpenFailure(discovery.discover(bareRepository), 'NOT_GIT_REPOSITORY');
      expect(existsSync(join(plainDirectory, '.git'))).toBe(false);
    });
  });

  it('does not let inherited Git environment redirect repository discovery', async () => {
    await withTemporaryDirectory(async (directory) => {
      const repositoryPath = join(directory, 'actual-repository');
      const plainDirectory = join(directory, 'plain-directory');
      initializeGitRepository(repositoryPath);
      mkdirSync(plainDirectory);
      const originalGitDirectory = process.env.GIT_DIR;
      const originalGitWorkTree = process.env.GIT_WORK_TREE;

      process.env.GIT_DIR = join(repositoryPath, '.git');
      process.env.GIT_WORK_TREE = repositoryPath;

      try {
        const discovery = new LocalGitProjectDiscovery();

        await expectProjectOpenFailure(discovery.discover(plainDirectory), 'NOT_GIT_REPOSITORY');
      } finally {
        restoreEnvironmentVariable('GIT_DIR', originalGitDirectory);
        restoreEnvironmentVariable('GIT_WORK_TREE', originalGitWorkTree);
      }
    });
  });

  it.runIf(process.platform === 'win32')(
    'does not execute a repository-controlled Git executable from the selected directory',
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const repositoryPath = join(directory, 'repository');
        initializeGitRepository(repositoryPath);
        writeFileSync(join(repositoryPath, 'git.exe'), 'not a Windows executable');
        const discovery = new LocalGitProjectDiscovery();

        await expect(discovery.discover(repositoryPath)).resolves.toMatchObject({
          name: 'repository',
        });
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    'keeps repositories that differ only by case distinct on a case-sensitive directory',
    async (context) => {
      await withTemporaryDirectory(async (directory) => {
        const caseSensitiveDirectory = join(directory, 'case-sensitive');
        mkdirSync(caseSensitiveDirectory);

        try {
          execFileSync(
            join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'fsutil.exe'),
            ['file', 'SetCaseSensitiveInfo', caseSensitiveDirectory, 'enable'],
            { stdio: 'ignore', windowsHide: true },
          );
        } catch {
          context.skip();
          return;
        }

        const uppercaseRepository = join(caseSensitiveDirectory, 'Repo');
        const lowercaseRepository = join(caseSensitiveDirectory, 'repo');
        initializeGitRepository(uppercaseRepository);
        initializeGitRepository(lowercaseRepository);
        const discovery = new LocalGitProjectDiscovery();

        const uppercase = await discovery.discover(uppercaseRepository);
        const lowercase = await discovery.discover(lowercaseRepository);

        expect(lowercase.id).not.toBe(uppercase.id);
        expect(lowercase.pathIdentity).not.toBe(uppercase.pathIdentity);
      });
    },
  );

  it('reports when the configured Git executable is unavailable', async () => {
    await withTemporaryDirectory(async (directory) => {
      const discovery = new LocalGitProjectDiscovery('missing-agentterm-git.exe');

      await expectProjectOpenFailure(discovery.discover(directory), 'GIT_NOT_AVAILABLE');
    });
  });

  it.runIf(process.platform === 'win32')(
    'reports an executable that cannot be launched as unavailable Git',
    async () => {
      await withTemporaryDirectory(async (directory) => {
        const invalidExecutable = join(directory, 'invalid-git.exe');
        writeFileSync(invalidExecutable, 'not a Windows executable');
        const discovery = new LocalGitProjectDiscovery(invalidExecutable);

        await expectProjectOpenFailure(discovery.discover(directory), 'GIT_NOT_AVAILABLE');
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
