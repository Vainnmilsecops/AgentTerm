import { createHash } from 'node:crypto';
import { basename, parse } from 'node:path';

import {
  ProjectOpenError,
  type DiscoveredProject,
  type ProjectDiscovery,
  type ProjectOpenFailure,
} from '@agentterm/application';

import { GitCli, GitWorkingTreeAccessError } from './git-cli';

export class LocalGitProjectDiscovery implements ProjectDiscovery {
  private readonly git: GitCli;

  public constructor(configuredGitExecutable = 'git') {
    this.git = new GitCli(configuredGitExecutable);
  }

  public async discover(inputPath: string): Promise<DiscoveredProject> {
    let rootPath: string;

    try {
      rootPath = await this.git.resolveWorkingTreeRoot(inputPath);
    } catch (error) {
      throw mapProjectOpenError(error, inputPath);
    }

    const pathIdentity = createPathIdentity(rootPath);

    return Object.freeze({
      id: `project-${createHash('sha256').update(pathIdentity).digest('hex')}`,
      name: basename(rootPath) || parse(rootPath).root,
      pathIdentity,
      rootPath,
    });
  }
}

function createPathIdentity(rootPath: string): string {
  return process.platform === 'win32' ? `win32:${rootPath}` : `posix:${rootPath}`;
}

function mapProjectOpenError(error: unknown, inputPath: string): ProjectOpenError {
  if (!(error instanceof GitWorkingTreeAccessError)) {
    return new ProjectOpenError('GIT_INSPECTION_FAILED', inputPath);
  }

  const reason: ProjectOpenFailure =
    error.reason === 'NOT_WORKING_TREE' ? 'NOT_GIT_REPOSITORY' : error.reason;
  return new ProjectOpenError(reason, inputPath);
}
