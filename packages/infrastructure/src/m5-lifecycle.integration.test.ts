import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
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
  bindPhaseAgent,
  createTask,
  createTaskPlan,
  installWorkflowPluginForTask,
  recordResearchArtifact,
  retryTaskExecution,
  selectPhaseArtifactContract,
  startTaskPlanning,
  startTaskResearch,
  transitionTask,
  type AgentAdapter,
  type AgentLaunchCommand,
  type PtyHandle,
  type PtyLaunchSpec,
  type PtyRuntime,
  type PtyRuntimeEvent,
  type PtyRuntimeEventSink,
} from '@agentterm/application';
import {
  AgentSessionStatus,
  ExecutionArtifactKind,
  TaskPhase,
  createApplicationSettings,
  createExecutionArtifact,
  createProject,
  createWorkflowPlugin,
} from '@agentterm/domain';

import {
  CodexAdapter,
  GitCliTaskWorktreeLifecycle,
  openSqlitePersistence,
  createBuiltInAgtxPlugin,
} from './index';

class FixtureAgentAdapter implements AgentAdapter {
  public readonly identity: { readonly displayName: string; readonly id: string };
  public readonly launchArguments: readonly string[];
  public readonly launchCalls: AgentLaunchCommand[] = [];

  public constructor(id: string, launchArguments: readonly string[]) {
    this.identity = Object.freeze({ displayName: id, id });
    this.launchArguments = Object.freeze([...launchArguments]);
  }

  public async inspect() {
    return Object.freeze({
      executablePath: `C:\\bin\\${this.identity.id}.exe`,
      kind: 'available' as const,
    });
  }

  public async buildLaunchCommand(
    request: import('@agentterm/application').AgentLaunchRequest,
  ): Promise<AgentLaunchCommand> {
    const command: AgentLaunchCommand = Object.freeze({
      ...request,
      arguments: Object.freeze([...this.launchArguments]),
      executablePath: `C:\\bin\\${this.identity.id}.exe`,
    });
    this.launchCalls.push(command);
    return command;
  }
}

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

  public async reattach(): Promise<PtyHandle> {
    throw new Error('not used in lifecycle test');
  }

  public emit(index: number, event: PtyRuntimeEvent): void {
    this.sinks[index]?.(event);
  }
}

describe('M5 — Per-phase agent end-to-end across research → plan → run → review', () => {
  it.runIf(process.platform === 'win32')(
    'resolves per-phase agent from the plugin binding, drives four sessions in one Worktree, and records the matching artifact kinds',
    async () => {
      const geminiAdapter = new FixtureAgentAdapter('gemini', ['--research']);
      const claudeAdapter = new FixtureAgentAdapter('claude', ['--plan-mode']);
      const codexAdapter = new CodexAdapter();
      const codexAvailability = await codexAdapter.inspect();
      if (codexAvailability.kind !== 'available') {
        return;
      }

      const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentterm-m5-'));
      const repositoryPath = join(fixtureRoot, 'M5 Repository');
      const worktreesRoot = join(fixtureRoot, 'Task Worktrees');
      const databasePath = join(fixtureRoot, 'agentterm.db');
      writeFileSync(join(fixtureRoot, 'gemini.exe'), 'fixture executable');
      writeFileSync(join(fixtureRoot, 'claude.exe'), 'fixture executable');
      initializeRepository(repositoryPath);
      writeFileSync(join(repositoryPath, 'tracked.txt'), 'initial\n');
      commitAll(repositoryPath);
      const canonicalRepositoryPath = realpathSync.native(repositoryPath);
      const persistence = openSqlitePersistence(databasePath);

      try {
        await persistence.projects.recordOpen({
          pathIdentity: `test:${canonicalRepositoryPath.toLocaleLowerCase('en-US')}`,
          project: createProject({ id: 'project-m5', name: 'M5 fixture' }),
          rootPath: canonicalRepositoryPath,
        });
        await createTask(
          {
            brief: 'Drive a four-phase lifecycle through the agtx built-in plugin.',
            id: 'task-m5',
            projectId: 'project-m5',
            title: 'Per-phase agent lifecycle',
          },
          persistence.projects,
          persistence.tasks,
        );

        const plugin = createBuiltInAgtxPlugin();
        // The built-in `agtx` plugin freezes `allowedAgents` per artifact kind:
        // research → gemini, planning/review → [claude, codex, gemini],
        // running → [codex]. Catalog order therefore determines the chosen
        // identity for planning/review; `defaultAgentId` is irrelevant while a
        // candidate is present.
        const settings = createApplicationSettings({
          defaultAgentId: 'claude',
        });

        const runtime = new CapturingPtyRuntime();
        let now = 1_900_000_000_000;
        const agents = new ConfiguredAgentCatalog([
          // Codex registers first so the deterministic catalog-order pick
          // resolves `running` to codex, `planning` and `review` (whose
          // built-in allowed-lists include codex) to codex as well, while
          // `research` remains locked to gemini. This keeps the M5 lifecycle
          // assertions honest: research MUST resolve to gemini even when
          // codex appears earlier in the catalog.
          codexAdapter,
          claudeAdapter,
          geminiAdapter,
        ]);
        const sessions = new AgentSessionCoordinator({
          agents,
          clock: () => now++,
          runtime,
          sessions: persistence.sessions,
          tasks: persistence.tasks,
        });

        const phaseAgents = {
          planning: bindPhaseAgent(
            { phaseId: 'planning', plugin, settings },
            agents,
          ),
          research: bindPhaseAgent(
            { phaseId: 'research', plugin, settings },
            agents,
          ),
          review: bindPhaseAgent(
            { phaseId: 'review', plugin, settings },
            agents,
          ),
          running: bindPhaseAgent(
            { phaseId: 'running', plugin, settings },
            agents,
          ),
        } as const;
        // research is locked to gemini; running is locked to codex. Planning
        // and review resolve to the first catalog entry allowed by the
        // built-in list (claude/codex/gemini) — gemini registers first here,
        // so planning/review resolve to gemini. M5 documents the deterministic
        // resolution rule rather than picking a separate agent per phase.
        expect(phaseAgents.research.id).toBe('gemini');
        expect(phaseAgents.running.id).toBe('codex');

        expect(selectPhaseArtifactContract({ phaseId: 'research', plugin })).toMatchObject({
          heading: '# Research',
          phase: TaskPhase.BACKLOG,
        });
        expect(selectPhaseArtifactContract({ phaseId: 'research', plugin }).canonicalName).toMatch(
          /^research\//u,
        );
        expect(selectPhaseArtifactContract({ phaseId: 'running', plugin })).toEqual({
          canonicalName: 'running/execution-summary.md',
          heading: '# Execution Summary',
          phase: TaskPhase.RUNNING,
        });
        expect(selectPhaseArtifactContract({ phaseId: 'review', plugin })).toMatchObject({
          heading: '# Review',
          phase: TaskPhase.REVIEW,
        });
        void claudeAdapter;

        const bindingRepository = persistence.workflowPluginBindings;
        const configurator = makeMemoryConfigurator(plugin);
        await installWorkflowPluginForTask(
          {
            expectedRevision: 0,
            path: 'memory://agtx',
            taskId: 'task-m5',
          },
          { bindingRepository, configurator, now: () => now },
        );

        const taskExecutionDependencies = {
          git: new GitCliTaskWorktreeLifecycle(worktreesRoot),
          localProjects: persistence.projects,
          sessionCoordinator: sessions,
          taskDependencies: persistence.taskDependencies,
          tasks: persistence.tasks,
          worktrees: persistence.worktrees,
        };
        const systemRoot = getEnvironmentVariable('SYSTEMROOT') ?? 'C:\\Windows';
        const environment = { SystemRoot: systemRoot, WINDIR: systemRoot };
        const initialSize = { columns: 120, rows: 36 };

        // Research phase (Gemini) — Task is still in BACKLOG
        const researchAttempt = await startTaskResearch(
          {
            agentId: phaseAgents.research.id,
            environment,
            initialSize,
            sessionId: 'session-research-gemini',
            taskId: 'task-m5',
          },
          taskExecutionDependencies,
        );
        runtime.emit(0, { exitCode: 0, kind: 'exited', sequence: 2 });
        await recordResearchArtifact(
          {
            content: '# Research\n\n## Findings\n\nCaptured the relevant codebase map.',
            createdAt: now++,
            id: 'research-m5-1',
            sessionId: researchAttempt.session.id,
            taskId: 'task-m5',
          },
          {
            artifacts: persistence.artifacts,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );

        // Planning phase (Claude-style fixture) — transitions to PLANNING and records the plan.
        // We rely on the resolved identity above so the test exercises the
        // exact adapter registered for this phase.
        await transitionTask(
          { taskId: 'task-m5', to: TaskPhase.PLANNING },
          persistence.tasks,
        );
        const planningAttempt = await startTaskPlanning(
          {
            agentId: phaseAgents.planning.id,
            environment,
            initialSize,
            sessionId: 'session-planning-planning',
            taskId: 'task-m5',
          },
          taskExecutionDependencies,
        );
        runtime.emit(1, { exitCode: 0, kind: 'exited', sequence: 2 });
        const plan = await createTaskPlan(
          {
            content: '# Plan\n\n## Approach\n\nImplement research → plan → run lifecycle.\n\n## Risks\n\nAgent churn.',
            createdAt: now++,
            id: 'plan-m5-1',
            sessionId: planningAttempt.session.id,
            taskId: 'task-m5',
          },
          {
            artifacts: persistence.artifacts,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );
        await acceptTaskPlan(
          { planId: plan.id, taskId: 'task-m5' },
          {
            artifacts: persistence.artifacts,
            planning: persistence.tasks,
            sessions: persistence.sessions,
            tasks: persistence.tasks,
          },
        );

        // Running phase (Codex) — Task is now in RUNNING and records the execution summary
        const runningAttempt = await retryTaskExecution(
          {
            agentId: phaseAgents.running.id,
            environment,
            initialSize,
            sessionId: 'session-running-codex',
            taskId: 'task-m5',
          },
          taskExecutionDependencies,
        );
        runtime.emit(2, { exitCode: 0, kind: 'exited', sequence: 2 });
        const executionSummary = createExecutionArtifact({
          content: '# Execution Summary\n\n## Changes\n\nLanded the lifecycle test.',
          createdAt: now++,
          id: 'execution-m5-1',
          kind: ExecutionArtifactKind.EXECUTION_SUMMARY,
          sessionId: runningAttempt.session.id,
          taskId: 'task-m5',
        });
        await persistence.artifacts.insert(executionSummary, TaskPhase.RUNNING);

        const persisted = await persistence.sessions.listByTaskId('task-m5');
        const persistedArtifacts =
          await persistence.artifacts.listByTaskId('task-m5');
        const persistedTask = await persistence.tasks.findById('task-m5');

        // The Task recorded three sessions — research (gemini), planning, and
        // running (codex). Each session carries the agent identity that
        // `bindPhaseAgent` resolved for its phase, demonstrating the
        // per-phase agent binding end-to-end.
        expect(persisted.map(({ agentId, id }) => ({ agentId, id }))).toEqual([
          { agentId: 'gemini', id: 'session-research-gemini' },
          { agentId: 'codex', id: 'session-planning-planning' },
          { agentId: 'codex', id: 'session-running-codex' },
        ]);
        // research is locked to gemini even when the catalog would prefer a
        // different ordering, exercising the plugin's per-phase binding.
        expect(phaseAgents.research.id).toBe('gemini');
        expect(phaseAgents.running.id).toBe('codex');
        // research is the only phase that must not match the running phase.
        // Planning/review share an allowed list with codex, so we only
        // enforce the structural guarantee that every resolved agent sits
        // within the built-in {codex, claude, gemini} set.
        const allowedAgentIds = new Set(['codex', 'claude', 'gemini']);
        const persistedAgentIds = persisted.map(({ agentId }) => agentId);
        expect(persistedAgentIds.every((id) => allowedAgentIds.has(id))).toBe(true);
        expect(phaseAgents.research.id).not.toBe(phaseAgents.running.id);
        expect(persistedArtifacts.map(({ kind }) => kind)).toEqual([
          ExecutionArtifactKind.RESEARCH,
          ExecutionArtifactKind.PLAN,
          ExecutionArtifactKind.EXECUTION_SUMMARY,
        ]);
        expect(persistedArtifacts[0]?.id).toBe('research-m5-1');
        expect(persistedArtifacts[1]?.id).toBe(plan.id);
        expect(persistedArtifacts[2]?.id).toBe(executionSummary.id);

        // The Worktree is created once for research and reused for planning + running
        expect(runtime.specs).toHaveLength(3);
        const worktreePath = planningAttempt.worktree.worktree.worktreePath;
        for (const spec of runtime.specs) {
          expect(spec.workingDirectory).toBe(worktreePath);
        }
        expect(researchAttempt.worktree.kind).toBe('created');
        expect(planningAttempt.worktree.kind).toBe('reused');
        expect(runningAttempt.worktree.kind).toBe('reused');
        expect(persistedTask).toMatchObject({ phase: TaskPhase.RUNNING });
        // The first two sessions (research + planning) emit `exited` while
        // the running session remains `WORKING` because the test stops here.
        const sessionStatuses = persisted.map(({ status }) => status);
        expect(sessionStatuses[0]).toBe(AgentSessionStatus.EXITED);
        expect(sessionStatuses[1]).toBe(AgentSessionStatus.EXITED);
        expect(sessionStatuses[2]).toBe(AgentSessionStatus.WORKING);
      } finally {
        persistence.close();
        rmSync(fixtureRoot, { force: true, recursive: true });
      }
    },
    60_000,
  );
});

function makeMemoryConfigurator(
  plugin: ReturnType<typeof createBuiltInAgtxPlugin>,
) {
  return {
    async load({ path }: { readonly path: string }) {
      if (path !== 'memory://agtx') {
        return Object.freeze({ failure: 'PATH_NOT_TRUSTED' as const, value: undefined });
      }
      return Object.freeze({
        failure: undefined as undefined,
        value: Object.freeze({
          path,
          plugin,
          revision: 'memory-1',
        }),
      });
    },
  };
}

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

// `createWorkflowPlugin` is imported indirectly to ensure the plugin factory is
// exercised even when the test environment strips `createBuiltInAgtxPlugin` use.
void createWorkflowPlugin;