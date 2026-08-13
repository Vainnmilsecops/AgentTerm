import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentSessionCoordinator,
  ConfiguredAgentCatalog,
  createTask,
  retryTaskExecution,
  startTaskExecution,
  transitionTask,
  type PtyHandle,
  type PtyLaunchSpec,
  type PtyRuntime,
  type PtyRuntimeEvent,
  type PtyRuntimeEventSink,
} from '@agentterm/application';
import { AgentSessionStatus, TaskPhase, createProject } from '@agentterm/domain';

import { CodexAdapter, GitCliTaskWorktreeLifecycle, openSqlitePersistence } from './index';

class CapturingPtyRuntime implements PtyRuntime {
  public readonly specs: PtyLaunchSpec[] = [];
  private readonly sinks: PtyRuntimeEventSink[] = [];

  public async open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle> {
    this.specs.push(spec);
    this.sinks.push(sink);
    sink({ kind: 'started', sequence: 1 });
    return {
      dispose: async () => undefined,
      resize: async () => undefined,
      terminate: async () => undefined,
      write: async () => undefined,
    };
  }

  public emit(index: number, event: PtyRuntimeEvent): void {
    this.sinks[index]?.(event);
  }
}

describe('Task execution with real Git, SQLite, and Codex command construction', () => {
  it.runIf(process.platform === 'win32')(
    'reuses one primary Worktree while preserving each Session and keeping Task RUNNING',
    async (context) => {
      const adapter = new CodexAdapter();
      const availability = await adapter.inspect();
      if (availability.kind !== 'available') {
        context.skip();
        return;
      }

      const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentterm-execution-'));
      const repositoryPath = join(fixtureRoot, 'Repository With Spaces');
      const worktreesRoot = join(fixtureRoot, 'Task Worktrees');
      const databasePath = join(fixtureRoot, 'agentterm.db');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'tracked.txt'), 'initial\n');
      commitAll(repositoryPath);
      const canonicalRepositoryPath = realpathSync.native(repositoryPath);
      let persistence = openSqlitePersistence(databasePath);

      try {
        await persistence.projects.recordOpen({
          pathIdentity: `test:${canonicalRepositoryPath.toLocaleLowerCase('en-US')}`,
          project: createProject({ id: 'project-execution', name: 'Execution fixture' }),
          rootPath: canonicalRepositoryPath,
        });
        await createTask(
          {
            id: 'task-execution',
            projectId: 'project-execution',
            title: 'Launch Codex in a Task Worktree',
          },
          persistence.projects,
          persistence.tasks,
        );
        await transitionTask(
          { taskId: 'task-execution', to: TaskPhase.PLANNING },
          persistence.tasks,
        );

        const runtime = new CapturingPtyRuntime();
        let now = 1_800_000_000_000;
        const sessions = new AgentSessionCoordinator({
          agents: new ConfiguredAgentCatalog([adapter]),
          clock: () => now++,
          runtime,
          sessions: persistence.sessions,
          tasks: persistence.tasks,
        });
        const dependencies = {
          git: new GitCliTaskWorktreeLifecycle(worktreesRoot),
          localProjects: persistence.projects,
          sessionCoordinator: sessions,
          tasks: persistence.tasks,
          worktrees: persistence.worktrees,
        };
        const systemRoot = getEnvironmentVariable('SYSTEMROOT') ?? 'C:\\Windows';
        const input = {
          agentId: 'codex',
          environment: { SystemRoot: systemRoot, WINDIR: systemRoot },
          initialSize: { columns: 120, rows: 36 },
          sessionId: 'session-execution-1',
          taskId: 'task-execution',
        };

        const first = await startTaskExecution(input, dependencies);
        runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
        await sessions.findById(input.sessionId);
        const trackedPath = join(first.worktree.worktree.worktreePath, 'tracked.txt');
        const untrackedPath = join(first.worktree.worktree.worktreePath, 'recovery-notes.txt');
        writeFileSync(trackedPath, 'uncommitted retry work\n');
        writeFileSync(untrackedPath, 'preserve this Vietnamese recovery note\n');
        persistence.close();
        persistence = openSqlitePersistence(databasePath);
        const recoveredSessions = new AgentSessionCoordinator({
          agents: new ConfiguredAgentCatalog([adapter]),
          clock: () => now++,
          runtime,
          sessions: persistence.sessions,
          tasks: persistence.tasks,
        });
        const second = await retryTaskExecution(
          {
            environment: input.environment,
            initialSize: input.initialSize,
            sessionId: 'session-execution-2',
            taskId: input.taskId,
          },
          {
            git: new GitCliTaskWorktreeLifecycle(worktreesRoot),
            localProjects: persistence.projects,
            sessionCoordinator: recoveredSessions,
            tasks: persistence.tasks,
            worktrees: persistence.worktrees,
          },
        );

        expect(first.worktree.kind).toBe('created');
        expect(second.worktree.kind).toBe('reused');
        expect(second.worktree.worktree).toEqual(first.worktree.worktree);
        expect(second.worktree.status).toMatchObject({
          isDirty: true,
          unstagedPaths: ['tracked.txt'],
          untrackedPaths: ['recovery-notes.txt'],
        });
        expect(readFileSync(trackedPath, 'utf8')).toBe('uncommitted retry work\n');
        expect(readFileSync(untrackedPath, 'utf8')).toBe(
          'preserve this Vietnamese recovery note\n',
        );
        expect(existsSync(first.worktree.worktree.worktreePath)).toBe(true);
        expect(runtime.specs).toHaveLength(2);
        for (const spec of runtime.specs) {
          expect(spec.executablePath).toBeTruthy();
          expect(spec.workingDirectory).toBe(first.worktree.worktree.worktreePath);
          expect(spec.arguments.slice(-2)).toEqual(['--cd', first.worktree.worktree.worktreePath]);
        }
        await expect(persistence.tasks.findById(input.taskId)).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
        await expect(persistence.sessions.listByTaskId(input.taskId)).resolves.toMatchObject([
          { agentId: 'codex', id: input.sessionId, status: AgentSessionStatus.EXITED },
          { agentId: 'codex', id: 'session-execution-2', status: AgentSessionStatus.WORKING },
        ]);
        expect(countRegisteredWorktrees(canonicalRepositoryPath)).toBe(2);
      } finally {
        persistence.close();
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
    30_000,
  );
});

function initializeRepository(repositoryPath: string): void {
  execFileSync('git', ['init', '--initial-branch=main', '--quiet', repositoryPath], {
    cwd: dirname(process.execPath),
    env: createTestGitEnvironment(),
    stdio: 'ignore',
    windowsHide: true,
  });
}

function commitAll(repositoryPath: string): void {
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
    'Initial commit',
  ]);
}

function countRegisteredWorktrees(repositoryPath: string): number {
  return runGit(repositoryPath, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((record) => record.startsWith('worktree ')).length;
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

function getEnvironmentVariable(name: string): string | undefined {
  const normalized = name.toUpperCase();
  return Object.entries(process.env).find(([key]) => key.toUpperCase() === normalized)?.[1];
}
