import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import {
  AgentSessionCoordinator,
  acceptTaskPlan,
  addTaskDependency,
  approveTaskReview,
  createTask as createApplicationTask,
  createExecutionArtifact,
  createTaskPullRequest,
  getTaskFileDiff,
  importQualityGateConfig,
  inspectTaskPullRequest,
  listQualityGateSummaries,
  listProjectTasks,
  listTaskChanges,
  listTaskDependencies,
  listTaskReviews,
  loadAgentWorkspace,
  loadApplicationSettings,
  loadWorkspaceLayout,
  openProject as openApplicationProject,
  pushTaskBranch,
  refreshTaskPullRequest,
  registerQualityGate,
  removeTaskDependency,
  requestTaskChanges,
  requestTaskReview,
  restoreAgentSessionsAfterRestart,
  retryTaskExecution,
  runQualityGate,
  saveWorkspaceLayout,
  summarizeTaskReview,
  startTaskExecution,
  startTaskPlanning,
  transitionTask,
  unregisterQualityGate,
  updateApplicationSettings,
} from '@agentterm/application';
import type {
  QualityGateConfiguration,
  QualityGateConfiguratorFailure,
} from '@agentterm/application';
import {
  BuiltInAgentConfigurationInspector,
  GitCliTaskReviewCodeInspector,
  GitCliTaskWorktreeLifecycle,
  GitHubPullRequestAdapter,
  JsonFileQualityGateCatalog,
  LocalGitProjectDiscovery,
  NodeQualityGateProcessRunner,
  WindowsConPtyRuntime,
  createBuiltInAgentCatalogFromSettings,
  createQualityGateConfigurator,
  openSqlitePersistence,
} from '@agentterm/infrastructure';

import type { DesktopIpcApplication } from './desktop-main-handlers';

export interface ProductionDesktopApplication extends DesktopIpcApplication {
  dispose(): void;
}

export interface ProductionDesktopApplicationOptions {
  readonly clock?: () => number;
  readonly dataDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}

const initialTerminalSize = Object.freeze({ columns: 80, rows: 24 });
const maximumQualityGateOutputBytes = 256 * 1024;

export async function createProductionDesktopApplication(
  options: ProductionDesktopApplicationOptions,
): Promise<ProductionDesktopApplication> {
  const dataDirectory = resolveDataDirectory(options.dataDirectory);
  mkdirSync(dataDirectory, { recursive: true });
  const persistence = openSqlitePersistence(join(dataDirectory, 'agentterm.db'));
  try {
    const clock = options.clock ?? Date.now;
    const environment = snapshotLaunchEnvironment(options.environment ?? process.env);
    const settings = await persistence.settings.get();
    const agents = createBuiltInAgentCatalogFromSettings(settings);
    const agentInspector = new BuiltInAgentConfigurationInspector();
    const git = new GitCliTaskWorktreeLifecycle(join(dataDirectory, 'worktrees'));
    const codeInspector = new GitCliTaskReviewCodeInspector();
    const pullRequestIntegration = new GitHubPullRequestAdapter();
    const projectDiscovery = new LocalGitProjectDiscovery();
    const sessionCoordinator = new AgentSessionCoordinator({
      agents,
      clock,
      runtime: new WindowsConPtyRuntime(),
      sessions: persistence.sessions,
      tasks: persistence.tasks,
    });
    const qualityGateRunner = new NodeQualityGateProcessRunner();
    const qualityGateCatalog = new JsonFileQualityGateCatalog({
      filePath: join(dataDirectory, 'quality-gates.json'),
    });
    const trustRoots = resolveQualityGateConfigTrustRoots(options.environment ?? process.env);
    const qualityGateConfigurator = createQualityGateConfigurator({
      trustRoots,
    });
    await restoreAgentSessionsAfterRestart(persistence.sessions, clock);

    const settingsDependencies = Object.freeze({
      catalog: agents,
      inspector: agentInspector,
      settings: persistence.settings,
    });
    const executionDependencies = Object.freeze({
      git,
      localProjects: persistence.projects,
      sessionCoordinator,
      taskDependencies: persistence.taskDependencies,
      tasks: persistence.tasks,
      worktrees: persistence.worktrees,
    });
    const planningDependencies = Object.freeze({
      artifacts: persistence.artifacts,
      planning: persistence.tasks,
      sessions: persistence.sessions,
      tasks: persistence.tasks,
    });
    const reviewDependencies = Object.freeze({
      artifacts: persistence.artifacts,
      clock,
      codeInspector,
      git,
      localProjects: persistence.projects,
      qualityGateRuns: persistence.qualityGateRuns,
      reviews: persistence.reviews,
      sessions: persistence.sessions,
      tasks: persistence.tasks,
      worktrees: persistence.worktrees,
    });
    const pullRequestDependencies = Object.freeze({
      integration: pullRequestIntegration,
      pullRequests: persistence.pullRequests,
      tasks: persistence.tasks,
      worktrees: persistence.worktrees,
    });
    const qualityGateDependencies = Object.freeze({
      clock,
      gates: qualityGateCatalog,
      git,
      localProjects: persistence.projects,
      maxOutputBytes: maximumQualityGateOutputBytes,
      processRunner: qualityGateRunner,
      runs: persistence.qualityGateRuns,
      tasks: persistence.tasks,
      worktrees: persistence.worktrees,
    });
    const workspaceLayoutDependencies = Object.freeze({
      clock,
      repository: persistence.workspaceLayout,
    });
    let disposed = false;
    const requireOpen = (): void => {
      if (disposed) throw new Error('The desktop Application composition is closed.');
    };
    const newId = (): string => randomUUID();

    const application: ProductionDesktopApplication = {
      acceptTaskPlan: async (input): Promise<void> => {
        requireOpen();
        await acceptTaskPlan(input, planningDependencies);
      },
      addTaskDependency: async (input) => {
        requireOpen();
        return addTaskDependency(input, persistence.tasks, persistence.taskDependencies);
      },
      approveTaskReview: async (input): Promise<void> => {
        requireOpen();
        await approveTaskReview(input, reviewDependencies);
      },
      attachTerminal: async (input) => {
        requireOpen();
        return sessionCoordinator.attachTerminal(input);
      },
      beginTaskPlanning: async (input): Promise<void> => {
        requireOpen();
        await transitionTask({ taskId: input.taskId, to: 'PLANNING' }, persistence.tasks);
      },
      createArtifact: async (input) => {
        requireOpen();
        return createExecutionArtifact(
          input,
          persistence.tasks,
          persistence.sessions,
          persistence.artifacts,
        );
      },
      createTask: async (input) => {
        requireOpen();
        const taskId = `task-${newId()}`;
        await createApplicationTask(
          { ...input, id: taskId },
          persistence.projects,
          persistence.tasks,
        );
        return Object.freeze({ taskId });
      },
      createTaskPullRequest: async (input): Promise<void> => {
        requireOpen();
        await createTaskPullRequest(input, pullRequestDependencies);
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        persistence.close();
      },
      getTaskFileDiff: async (input) => {
        requireOpen();
        return getTaskFileDiff(input, persistence.tasks, persistence.worktrees, git);
      },
      inspectTaskPullRequest: async (input) => {
        requireOpen();
        return inspectTaskPullRequest(input, pullRequestDependencies);
      },
      listProjectTasks: async (input) => {
        requireOpen();
        return listProjectTasks(input.projectId, persistence.projects, persistence.tasks);
      },
      listQualityGateDetails: async () => {
        requireOpen();
        return qualityGateCatalog.list();
      },
      listQualityGates: async () => {
        requireOpen();
        return listQualityGateSummaries(qualityGateCatalog);
      },
      loadQualityGateConfig: async (input) => {
        requireOpen();
        return unwrapConfiguratorResult(await qualityGateConfigurator.load(input));
      },
      importQualityGateConfig: async (input) => {
        requireOpen();
        const result = await importQualityGateConfig(input, {
          catalog: qualityGateCatalog,
          configurator: qualityGateConfigurator,
        });
        return Object.freeze({
          configuration: result.configuration,
          registered: Object.freeze([...result.registered]),
          rejected: Object.freeze([...result.rejected]),
        });
      },
      listTaskChanges: async (input) => {
        requireOpen();
        return listTaskChanges(input, persistence.tasks, persistence.worktrees, git);
      },
      listTaskDependencies: async (input) => {
        requireOpen();
        return listTaskDependencies(input, persistence.tasks, persistence.taskDependencies);
      },
      listTaskReviews: async (input) => {
        requireOpen();
        const reviews = await listTaskReviews(input.taskId, persistence.tasks, persistence.reviews);
        return Object.freeze(reviews.map(summarizeTaskReview));
      },
      loadSettings: async () => {
        requireOpen();
        return loadApplicationSettings(settingsDependencies);
      },
      loadWorkspace: async () => {
        requireOpen();
        return loadAgentWorkspace(
          persistence.projects,
          persistence.tasks,
          persistence.sessions,
          persistence.artifacts,
          persistence.qualityGateRuns,
          persistence.reviews,
          agents,
          persistence.taskDependencies,
        );
      },
      loadWorkspaceLayout: async () => {
        requireOpen();
        return loadWorkspaceLayout(workspaceLayoutDependencies);
      },
      openProject: async (input): Promise<void> => {
        requireOpen();
        await openApplicationProject(input, projectDiscovery, persistence.projects);
      },
      pushTaskBranch: async (input): Promise<void> => {
        requireOpen();
        await pushTaskBranch(input, pullRequestDependencies);
      },
      refreshTaskPullRequest: async (input): Promise<void> => {
        requireOpen();
        await refreshTaskPullRequest(input, pullRequestDependencies);
      },
      registerQualityGate: async (input): Promise<void> => {
        requireOpen();
        await registerQualityGate(input, qualityGateCatalog);
      },
      removeTaskDependency: async (input) => {
        requireOpen();
        return removeTaskDependency(input, persistence.tasks, persistence.taskDependencies);
      },
      requestTaskChanges: async (input): Promise<void> => {
        requireOpen();
        await requestTaskChanges(input, reviewDependencies);
      },
      requestTaskReview: async (input): Promise<void> => {
        requireOpen();
        await requestTaskReview({ reviewId: newId(), taskId: input.taskId }, reviewDependencies);
      },
      retryTaskExecution: async (input): Promise<void> => {
        requireOpen();
        await retryTaskExecution(
          {
            ...input,
            environment,
            initialSize: initialTerminalSize,
            sessionId: newId(),
          },
          executionDependencies,
        );
      },
      runQualityGate: async (input): Promise<void> => {
        requireOpen();
        await runQualityGate({ ...input, environment, runId: newId() }, qualityGateDependencies);
      },
      saveQualityGateConfig: async (input) => {
        requireOpen();
        return unwrapConfiguratorResult(
          await qualityGateConfigurator.save(input),
        );
      },
      saveWorkspaceLayout: async (input) => {
        requireOpen();
        return saveWorkspaceLayout(input, workspaceLayoutDependencies);
      },
      selectQualityGateConfigPath: async () => {
        // The native file picker runs in the main process only; this stub keeps
        // the production composition's public surface aligned with the typed
        // desktop IPC bridge but never actually opens a dialog.
        requireOpen();
        return Object.freeze({ path: undefined, result: 'CANCELLED' as const });
      },
      startTaskExecution: async (input): Promise<void> => {
        requireOpen();
        await startTaskExecution(
          {
            ...input,
            environment,
            initialSize: initialTerminalSize,
            sessionId: newId(),
          },
          executionDependencies,
        );
      },
      startTaskPlanning: async (input): Promise<void> => {
        requireOpen();
        await startTaskPlanning(
          {
            ...input,
            environment,
            initialSize: initialTerminalSize,
            sessionId: newId(),
          },
          executionDependencies,
        );
      },
      unregisterQualityGate: async (input) => {
        requireOpen();
        return unregisterQualityGate(input.gateId, qualityGateCatalog);
      },
      updateSettings: async (input) => {
        requireOpen();
        return updateApplicationSettings(input, settingsDependencies);
      },
    };
    return Object.freeze(application);
  } catch (error) {
    persistence.close();
    throw error;
  }
}

function resolveDataDirectory(input: string): string {
  if (typeof input !== 'string' || input.trim().length === 0 || input.includes('\0')) {
    throw new TypeError('Desktop data directory is invalid.');
  }
  const resolved = resolve(input);
  if (!isAbsolute(resolved)) throw new TypeError('Desktop data directory must be absolute.');
  return resolved;
}

function snapshotLaunchEnvironment(input: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new TypeError('The desktop launch environment is invalid.');
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
}

function resolveQualityGateConfigTrustRoots(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment['AT_DESKTOP_GATE_CONFIG_ROOT'];
  if (raw === undefined) return Object.freeze([]);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return Object.freeze([]);
  if (trimmed.includes('\0')) {
    throw new TypeError('AT_DESKTOP_GATE_CONFIG_ROOT contains a NUL byte.');
  }
  const parts = trimmed.split(/[;]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return Object.freeze(parts);
}

function unwrapConfiguratorResult(
  result: { readonly failure: QualityGateConfiguratorFailure | undefined; readonly value: QualityGateConfiguration | undefined },
): { readonly failure: QualityGateConfiguratorFailure | undefined; readonly value: QualityGateConfiguration | undefined } {
  return result;
}
