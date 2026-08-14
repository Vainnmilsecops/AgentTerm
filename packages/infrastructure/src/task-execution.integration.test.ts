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
  acceptTaskPlan,
  createTaskPlan,
  createTask,
  retryTaskExecution,
  startTaskExecution,
  startTaskPlanning,
  transitionTask,
  type PtyHandle,
  type PtyLaunchSpec,
  type PtyRuntime,
  type PtyRuntimeEvent,
  type PtyRuntimeEventSink,
} from '@agentterm/application';
import {
  AgentSessionStatus,
  TaskPhase,
  createProject,
  transitionTask as transitionTaskState,
} from '@agentterm/domain';

import {
  CodexAdapter,
  createBuiltInAgentCatalog,
  GitCliTaskWorktreeLifecycle,
  openSqlitePersistence,
} from './index';

class CapturingPtyRuntime implements PtyRuntime {
  public readonly specs: PtyLaunchSpec[] = [];
  public readonly writes: string[] = [];
  private readonly sinks: PtyRuntimeEventSink[] = [];

  public async open(spec: PtyLaunchSpec, sink: PtyRuntimeEventSink): Promise<PtyHandle> {
    this.specs.push(spec);
    this.sinks.push(sink);
    sink({ kind: 'started', sequence: 1 });
    return {
      dispose: async () => undefined,
      resize: async () => undefined,
      terminate: async () => undefined,
      write: async (input) => {
        this.writes.push(input);
      },
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
            brief: 'Implement the execution slice while preserving Worktree and Session history.',
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
          taskDependencies: persistence.taskDependencies,
          tasks: persistence.tasks,
          worktrees: persistence.worktrees,
        };
        const systemRoot = getEnvironmentVariable('SYSTEMROOT') ?? 'C:\\Windows';
        const planningInput = {
          agentId: 'codex',
          environment: { SystemRoot: systemRoot, WINDIR: systemRoot },
          initialSize: { columns: 120, rows: 36 },
          sessionId: 'session-planning-1',
          taskId: 'task-execution',
        };

        const planningAttempt = await startTaskPlanning(planningInput, dependencies);
        runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
        await sessions.findById(planningInput.sessionId);
        const firstPlan = await createTaskPlan(
          {
            content: '# Plan\n\nImplement the execution slice without replacing prior evidence.',
            createdAt: now++,
            id: 'plan-execution-1',
            sessionId: planningInput.sessionId,
            taskId: planningInput.taskId,
          },
          {
            artifacts: persistence.artifacts,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );
        const trackedPath = join(planningAttempt.worktree.worktree.worktreePath, 'tracked.txt');
        const untrackedPath = join(
          planningAttempt.worktree.worktree.worktreePath,
          'recovery-notes.txt',
        );
        writeFileSync(trackedPath, 'uncommitted retry work\n');
        writeFileSync(untrackedPath, 'preserve this Vietnamese recovery note\n');
        const revisedPlanningAttempt = await startTaskPlanning(
          { ...planningInput, sessionId: 'session-planning-2' },
          dependencies,
        );
        expect(revisedPlanningAttempt.worktree).toMatchObject({
          kind: 'reused',
          status: {
            isDirty: true,
            unstagedPaths: ['tracked.txt'],
            untrackedPaths: ['recovery-notes.txt'],
          },
        });
        runtime.emit(1, { exitCode: 0, kind: 'exited', sequence: 2 });
        await sessions.findById('session-planning-2');
        const revisedPlan = await createTaskPlan(
          {
            content: '# Plan\n\nRevised Plan that preserves the existing dirty Worktree.',
            createdAt: now++,
            id: 'plan-execution-2',
            sessionId: 'session-planning-2',
            taskId: planningInput.taskId,
          },
          {
            artifacts: persistence.artifacts,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );
        await acceptTaskPlan(
          { planId: revisedPlan.id, taskId: planningInput.taskId },
          {
            artifacts: persistence.artifacts,
            planning: persistence.tasks,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );
        const first = await retryTaskExecution(
          {
            ...planningInput,
            sessionId: 'session-execution-1',
          },
          dependencies,
        );
        runtime.emit(2, { exitCode: 0, kind: 'exited', sequence: 2 });
        await sessions.findById('session-execution-1');
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
            agentId: planningInput.agentId,
            environment: planningInput.environment,
            initialSize: planningInput.initialSize,
            sessionId: 'session-execution-2',
            taskId: planningInput.taskId,
          },
          {
            git: new GitCliTaskWorktreeLifecycle(worktreesRoot),
            localProjects: persistence.projects,
            sessionCoordinator: recoveredSessions,
            taskDependencies: persistence.taskDependencies,
            tasks: persistence.tasks,
            worktrees: persistence.worktrees,
          },
        );

        expect(planningAttempt.worktree.kind).toBe('created');
        expect(first.worktree.kind).toBe('reused');
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
        expect(runtime.specs).toHaveLength(4);
        for (const spec of runtime.specs) {
          expect(spec.executablePath).toBeTruthy();
          expect(spec.workingDirectory).toBe(first.worktree.worktree.worktreePath);
          expect(spec.arguments.slice(-2)).toEqual(['--cd', first.worktree.worktree.worktreePath]);
          expect(JSON.stringify(spec)).not.toContain('preserving Worktree and Session history');
        }
        expect(runtime.writes).toHaveLength(4);
        expect(runtime.writes.slice(0, 2)).toEqual([
          expect.stringContaining('phase PLANNING'),
          expect.stringContaining('phase PLANNING'),
        ]);
        expect(runtime.writes.slice(2)).toEqual([
          expect.stringContaining('phase RUNNING'),
          expect.stringContaining('phase RUNNING'),
        ]);
        for (const kickoff of runtime.writes) {
          expect(kickoff).toContain('preserving Worktree and Session history');
          expect(kickoff.endsWith('\r')).toBe(true);
        }
        await expect(persistence.tasks.findById(planningInput.taskId)).resolves.toMatchObject({
          phase: TaskPhase.RUNNING,
        });
        await expect(
          persistence.sessions.listByTaskId(planningInput.taskId),
        ).resolves.toMatchObject([
          { agentId: 'codex', id: planningInput.sessionId, status: AgentSessionStatus.EXITED },
          { agentId: 'codex', id: 'session-planning-2', status: AgentSessionStatus.EXITED },
          { agentId: 'codex', id: 'session-execution-1', status: AgentSessionStatus.EXITED },
          { agentId: 'codex', id: 'session-execution-2', status: AgentSessionStatus.WORKING },
        ]);
        await expect(persistence.artifacts.listByTaskId(planningInput.taskId)).resolves.toEqual([
          firstPlan,
          revisedPlan,
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

describe('Task execution through the built-in agent catalog', () => {
  it.runIf(process.platform === 'win32')(
    'selects Claude and Gemini generically, launches in each Task Worktree, and keeps both Tasks RUNNING',
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentterm-provider-execution-'));
      const repositoryPath = join(fixtureRoot, 'Provider Repository');
      const worktreesRoot = join(fixtureRoot, 'Task Worktrees');
      const databasePath = join(fixtureRoot, 'agentterm.db');
      const claudeExecutable = join(fixtureRoot, 'claude.exe');
      const geminiExecutable = join(fixtureRoot, 'gemini.exe');
      writeFileSync(claudeExecutable, 'fixture executable');
      writeFileSync(geminiExecutable, 'fixture executable');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'tracked.txt'), 'initial\n');
      commitAll(repositoryPath);
      const canonicalRepositoryPath = realpathSync.native(repositoryPath);
      const persistence = openSqlitePersistence(databasePath);

      try {
        await persistence.projects.recordOpen({
          pathIdentity: `test:${canonicalRepositoryPath.toLocaleLowerCase('en-US')}`,
          project: createProject({ id: 'project-providers', name: 'Provider fixture' }),
          rootPath: canonicalRepositoryPath,
        });
        const agents = createBuiltInAgentCatalog({
          claudeExecutable,
          codexExecutable: join(fixtureRoot, 'missing-codex.exe'),
          geminiExecutable,
        });
        const runtime = new CapturingPtyRuntime();
        let now = 1_800_000_100_000;
        const sessions = new AgentSessionCoordinator({
          agents,
          clock: () => now++,
          runtime,
          sessions: persistence.sessions,
          tasks: persistence.tasks,
        });
        const dependencies = {
          git: new GitCliTaskWorktreeLifecycle(worktreesRoot),
          localProjects: persistence.projects,
          sessionCoordinator: sessions,
          taskDependencies: persistence.taskDependencies,
          tasks: persistence.tasks,
          worktrees: persistence.worktrees,
        };
        const worktreePaths = new Map<string, string>();

        for (const agentId of ['claude', 'gemini'] as const) {
          const taskId = `task-${agentId}`;
          await createTask(
            { id: taskId, projectId: 'project-providers', title: `Launch ${agentId}` },
            persistence.projects,
            persistence.tasks,
          );
          await transitionTask({ taskId, to: TaskPhase.PLANNING }, persistence.tasks);
          const planningTask = await persistence.tasks.findById(taskId);
          if (planningTask === undefined) throw new Error('fixture Task missing');
          await persistence.tasks.update(
            transitionTaskState(planningTask, TaskPhase.RUNNING),
            TaskPhase.PLANNING,
          );

          const result = await startTaskExecution(
            {
              agentId,
              environment: { SystemRoot: 'C:\\Windows' },
              initialSize: { columns: 100, rows: 30 },
              sessionId: `session-${agentId}`,
              taskId,
            },
            dependencies,
          );

          expect(result.session).toMatchObject({ agentId, status: AgentSessionStatus.WORKING });
          worktreePaths.set(agentId, result.worktree.worktree.worktreePath);
          expect(runtime.specs.at(-1)).toMatchObject({
            arguments: [],
            executablePath: realpathSync.native(join(fixtureRoot, `${agentId}.exe`)),
            workingDirectory: result.worktree.worktree.worktreePath,
          });
          await expect(persistence.tasks.findById(taskId)).resolves.toMatchObject({
            phase: TaskPhase.RUNNING,
          });
        }

        runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
        await sessions.findById('session-claude');
        const switched = await retryTaskExecution(
          {
            agentId: 'gemini',
            environment: { SystemRoot: 'C:\\Windows' },
            initialSize: { columns: 100, rows: 30 },
            sessionId: 'session-claude-retried-with-gemini',
            taskId: 'task-claude',
          },
          dependencies,
        );

        expect(switched.worktree).toMatchObject({
          kind: 'reused',
          worktree: { worktreePath: worktreePaths.get('claude') },
        });
        expect(switched.previousSession).toMatchObject({ agentId: 'claude', id: 'session-claude' });
        expect(switched.session).toMatchObject({
          agentId: 'gemini',
          id: 'session-claude-retried-with-gemini',
          status: AgentSessionStatus.WORKING,
        });
        await expect(persistence.sessions.listByTaskId('task-claude')).resolves.toMatchObject([
          { agentId: 'claude', id: 'session-claude', status: AgentSessionStatus.EXITED },
          {
            agentId: 'gemini',
            id: 'session-claude-retried-with-gemini',
            status: AgentSessionStatus.WORKING,
          },
        ]);
        expect(countRegisteredWorktrees(canonicalRepositoryPath)).toBe(3);

        rmSync(claudeExecutable);
        await createTask(
          {
            id: 'task-claude-launch-failure',
            projectId: 'project-providers',
            title: 'Preserve a failed Claude launch',
          },
          persistence.projects,
          persistence.tasks,
        );
        await transitionTask(
          { taskId: 'task-claude-launch-failure', to: TaskPhase.PLANNING },
          persistence.tasks,
        );
        const planningFailureTask = await persistence.tasks.findById('task-claude-launch-failure');
        if (planningFailureTask === undefined) throw new Error('fixture Task missing');
        await persistence.tasks.update(
          transitionTaskState(planningFailureTask, TaskPhase.RUNNING),
          TaskPhase.PLANNING,
        );
        const failure = await startTaskExecution(
          {
            agentId: 'claude',
            environment: { SystemRoot: 'C:\\Windows' },
            initialSize: { columns: 100, rows: 30 },
            sessionId: 'session-claude-launch-failure',
            taskId: 'task-claude-launch-failure',
          },
          dependencies,
        ).catch((error: unknown) => error);

        expect(failure).toMatchObject({
          name: 'TaskExecutionStartError',
          session: { agentId: 'claude', status: AgentSessionStatus.FAILED },
          stage: 'SESSION_START',
        });
        expect(runtime.specs).toHaveLength(3);
        await expect(
          persistence.tasks.findById('task-claude-launch-failure'),
        ).resolves.toMatchObject({ phase: TaskPhase.RUNNING });
        await expect(
          persistence.sessions.findById('session-claude-launch-failure'),
        ).resolves.toMatchObject({ agentId: 'claude', status: AgentSessionStatus.FAILED });
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
